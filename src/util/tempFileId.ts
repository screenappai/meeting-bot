import { encodeFileNameSafebase64 } from './strings';

export function generateTempFileId(userId: string, entityId: string): string {
  const tempId = `${userId}${entityId}${Date.now()}`;
  return encodeFileNameSafebase64(tempId);
}