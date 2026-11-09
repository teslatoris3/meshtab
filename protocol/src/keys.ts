import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, isHex } from './encoding.js';

// Enable the synchronous API of noble-ed25519 (works in Node, browsers and React Native).
ed.hashes.sha512 = sha512;

export interface KeyPair {
  /** 32-byte Ed25519 secret key, hex. Never leaves the device. */
  secretKey: string;
  /** 32-byte Ed25519 public key, hex. This is the wallet ID. */
  publicKey: string;
}

export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = ed.keygen();
  return { secretKey: bytesToHex(secretKey), publicKey: bytesToHex(publicKey) };
}

export function publicKeyFromSecret(secretKeyHex: string): string {
  return bytesToHex(ed.getPublicKey(hexToBytes(secretKeyHex)));
}

/** Signs a 32-byte digest (hex) and returns a 64-byte signature (hex). */
export function signDigest(digestHex: string, secretKeyHex: string): string {
  return bytesToHex(ed.sign(hexToBytes(digestHex), hexToBytes(secretKeyHex)));
}

export function verifyDigest(signatureHex: string, digestHex: string, publicKeyHex: string): boolean {
  if (!isHex(signatureHex, 64) || !isHex(digestHex, 32) || !isHex(publicKeyHex, 32)) return false;
  try {
    return ed.verify(hexToBytes(signatureHex), hexToBytes(digestHex), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}
