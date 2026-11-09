import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, hexToBytes, utf8ToBytes };

/** SHA-256 of a UTF-8 string, as lowercase hex. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** UTF-8 string to lowercase hex. Used so free text never breaks the canonical form. */
export function textToHex(text: string): string {
  return bytesToHex(utf8ToBytes(text));
}

export function isHex(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string') return false;
  if (!/^[0-9a-f]*$/.test(value) || value.length % 2 !== 0) return false;
  return bytes === undefined || value.length === bytes * 2;
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
