import fs from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

const SEGMENT_ID = '18538067';
const INFO_ID = '1549a966';
const TIMECODE_SCALE_ID = '2ad7b1';
const DURATION_ID = '4489';
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;
const HEADER_SCAN_BYTES = 4 * 1024 * 1024;

type EbmlElement = {
  idHex: string;
  idStart: number;
  idEnd: number;
  sizeStart: number;
  sizeEnd: number;
  sizeLength: number;
  size: number;
  unknownSize: boolean;
  dataStart: number;
  dataEnd: number;
};

type PatchPlan =
  | { type: 'in-place'; offset: number; data: Buffer }
  | { type: 'rewrite'; head: Buffer; replacement: Buffer; copyStart: number };

function getVintLength(firstByte: number): number {
  for (let length = 1; length <= 8; length++) {
    if ((firstByte & (1 << (8 - length))) !== 0) {
      return length;
    }
  }
  throw new Error('Invalid EBML variable-length integer');
}

function readElementId(buffer: Buffer, offset: number): { idHex: string; end: number } {
  if (offset >= buffer.length) {
    throw new Error('Unexpected end of buffer while reading EBML element id');
  }

  const length = getVintLength(buffer[offset]);
  const end = offset + length;
  if (end > buffer.length) {
    throw new Error('Unexpected end of buffer while reading EBML element id');
  }

  return {
    idHex: buffer.subarray(offset, end).toString('hex'),
    end,
  };
}

function readVintSize(buffer: Buffer, offset: number): { value: number; length: number; unknownSize: boolean; end: number } {
  if (offset >= buffer.length) {
    throw new Error('Unexpected end of buffer while reading EBML element size');
  }

  const firstByte = buffer[offset];
  const length = getVintLength(firstByte);
  const end = offset + length;
  if (end > buffer.length) {
    throw new Error('Unexpected end of buffer while reading EBML element size');
  }

  const marker = 1 << (8 - length);
  let value = firstByte & (marker - 1);
  for (let index = offset + 1; index < end; index++) {
    value = value * 256 + buffer[index];
  }

  const unknownSize = value === Math.pow(2, 7 * length) - 1;
  return { value, length, unknownSize, end };
}

function readElement(buffer: Buffer, offset: number, containerEnd: number): EbmlElement {
  const id = readElementId(buffer, offset);
  const size = readVintSize(buffer, id.end);
  const dataStart = size.end;
  const dataEnd = size.unknownSize ? containerEnd : dataStart + size.value;

  if (dataEnd > containerEnd) {
    throw new Error(`EBML element ${id.idHex} extends past its container`);
  }

  return {
    idHex: id.idHex,
    idStart: offset,
    idEnd: id.end,
    sizeStart: id.end,
    sizeEnd: size.end,
    sizeLength: size.length,
    size: size.value,
    unknownSize: size.unknownSize,
    dataStart,
    dataEnd,
  };
}

function findTopLevelElement(buffer: Buffer, fileSize: number, idHex: string): EbmlElement | undefined {
  let offset = 0;
  while (offset < buffer.length && offset < fileSize) {
    const element = readElement(buffer, offset, fileSize);
    if (element.idHex === idHex) {
      return element;
    }

    if (element.dataEnd <= offset || element.dataEnd > buffer.length) {
      break;
    }
    offset = element.dataEnd;
  }

  return undefined;
}

function findChildElement(buffer: Buffer, parent: EbmlElement, idHex: string): EbmlElement | undefined {
  let offset = parent.dataStart;
  while (offset < parent.dataEnd && offset < buffer.length) {
    const element = readElement(buffer, offset, parent.dataEnd);
    if (element.idHex === idHex) {
      return element;
    }

    if (element.dataEnd <= offset || element.dataEnd > buffer.length) {
      break;
    }
    offset = element.dataEnd;
  }

  return undefined;
}

function readUnsignedInteger(buffer: Buffer, start: number, end: number): number {
  let value = 0;
  for (let index = start; index < end; index++) {
    value = value * 256 + buffer[index];
  }
  return value;
}

function encodeVintSize(value: number, length: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid EBML size value: ${value}`);
  }

  const maxKnownValue = Math.pow(2, 7 * length) - 2;
  if (value > maxKnownValue) {
    throw new Error(`EBML size ${value} does not fit in ${length} bytes`);
  }

  const encoded = Buffer.alloc(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index--) {
    encoded[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }

  encoded[0] |= 1 << (8 - length);
  return encoded;
}

function createDurationElement(durationSeconds: number, timecodeScaleNs: number): Buffer {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Invalid WebM duration: ${durationSeconds}`);
  }
  if (!Number.isFinite(timecodeScaleNs) || timecodeScaleNs <= 0) {
    throw new Error(`Invalid WebM TimecodeScale: ${timecodeScaleNs}`);
  }

  const durationInTimecodeTicks = durationSeconds * 1_000_000_000 / timecodeScaleNs;
  const element = Buffer.alloc(11);
  element[0] = 0x44;
  element[1] = 0x89;
  element[2] = 0x88;
  element.writeDoubleBE(durationInTimecodeTicks, 3);
  return element;
}

function writeFloatPayload(durationSeconds: number, timecodeScaleNs: number, size: number): Buffer {
  const durationInTimecodeTicks = durationSeconds * 1_000_000_000 / timecodeScaleNs;
  const payload = Buffer.alloc(size);

  if (size === 4) {
    payload.writeFloatBE(durationInTimecodeTicks, 0);
    return payload;
  }
  if (size === 8) {
    payload.writeDoubleBE(durationInTimecodeTicks, 0);
    return payload;
  }

  throw new Error(`Unsupported existing WebM Duration payload size: ${size}`);
}

function updateKnownElementSize(buffer: Buffer, element: EbmlElement, delta: number): void {
  if (element.unknownSize) {
    return;
  }

  const size = encodeVintSize(element.size + delta, element.sizeLength);
  size.copy(buffer, element.sizeStart);
}

function createPatchPlan(prefix: Buffer, fileSize: number, durationSeconds: number): PatchPlan {
  const segment = findTopLevelElement(prefix, fileSize, SEGMENT_ID);
  if (!segment) {
    throw new Error('WebM Segment element was not found');
  }

  const info = findChildElement(prefix, segment, INFO_ID);
  if (!info) {
    throw new Error('WebM Info element was not found');
  }
  if (info.unknownSize) {
    throw new Error('Cannot append Duration to a WebM Info element with unknown size');
  }
  if (info.dataEnd > prefix.length) {
    throw new Error('WebM Info element is outside the scanned header range');
  }

  const timecodeScaleElement = findChildElement(prefix, info, TIMECODE_SCALE_ID);
  const timecodeScaleNs = timecodeScaleElement
    ? readUnsignedInteger(prefix, timecodeScaleElement.dataStart, timecodeScaleElement.dataEnd)
    : DEFAULT_TIMECODE_SCALE_NS;

  const durationElement = findChildElement(prefix, info, DURATION_ID);
  if (durationElement && (durationElement.size === 4 || durationElement.size === 8)) {
    return {
      type: 'in-place',
      offset: durationElement.dataStart,
      data: writeFloatPayload(durationSeconds, timecodeScaleNs, durationElement.size),
    };
  }

  const replacement = createDurationElement(durationSeconds, timecodeScaleNs);
  const replaceStart = durationElement ? durationElement.idStart : info.dataEnd;
  const copyStart = durationElement ? durationElement.dataEnd : info.dataEnd;
  const delta = replacement.length - (copyStart - replaceStart);
  const head = Buffer.from(prefix.subarray(0, replaceStart));

  updateKnownElementSize(head, info, delta);
  updateKnownElementSize(head, segment, delta);

  return {
    type: 'rewrite',
    head,
    replacement,
    copyStart,
  };
}

async function rewriteWebmFile(filePath: string, outputPath: string, plan: Extract<PatchPlan, { type: 'rewrite' }>): Promise<void> {
  await fs.promises.writeFile(outputPath, Buffer.concat([plan.head, plan.replacement]));

  const readStream = createReadStream(filePath, { start: plan.copyStart });
  const writeStream = createWriteStream(outputPath, { flags: 'a' });
  await pipeline(readStream, writeStream);
}

export async function writeWebmDurationMetadata(filePath: string, durationSeconds: number): Promise<void> {
  const stats = await fs.promises.stat(filePath);
  const bytesToRead = Math.min(stats.size, HEADER_SCAN_BYTES);
  const file = await fs.promises.open(filePath, 'r');
  let prefix: Buffer;

  try {
    prefix = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(prefix, 0, bytesToRead, 0);
    prefix = prefix.subarray(0, bytesRead);
  } finally {
    await file.close();
  }

  const plan = createPatchPlan(prefix, stats.size, durationSeconds);

  if (plan.type === 'in-place') {
    const writableFile = await fs.promises.open(filePath, 'r+');
    try {
      await writableFile.write(plan.data, 0, plan.data.length, plan.offset);
    } finally {
      await writableFile.close();
    }
    return;
  }

  const outputPath = `${filePath}.duration-patched.webm`;
  try {
    await rewriteWebmFile(filePath, outputPath, plan);
    await fs.promises.rename(outputPath, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(outputPath);
    } catch {}
    throw err;
  }
}
