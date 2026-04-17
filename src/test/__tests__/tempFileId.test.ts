import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { generateTempFileId } from '../../util/tempFileId';

describe('generateTempFileId', () => {
  let dateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1234567890);
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  it('should produce a non-empty string', () => {
    const result = generateTempFileId('user1', 'entity1');
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('should include a timestamp component so two calls with same args produce different results', () => {
    dateSpy.mockReturnValue(1000);
    const a = generateTempFileId('user1', 'entity1');
    dateSpy.mockReturnValue(2000);
    const b = generateTempFileId('user1', 'entity1');
    expect(a).not.toBe(b);
  });

  it('should produce base64url-safe output (no + / =)', () => {
    const result = generateTempFileId('user1', 'entity1');
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should be deterministic when Date.now is mocked', () => {
    const a = generateTempFileId('user1', 'entity1');
    const b = generateTempFileId('user1', 'entity1');
    expect(a).toBe(b);
  });

  it('should produce different output for different userId', () => {
    const a = generateTempFileId('userA', 'entity1');
    const b = generateTempFileId('userB', 'entity1');
    expect(a).not.toBe(b);
  });

  it('should produce different output for different entityId', () => {
    const a = generateTempFileId('user1', 'entityA');
    const b = generateTempFileId('user1', 'entityB');
    expect(a).not.toBe(b);
  });
});
