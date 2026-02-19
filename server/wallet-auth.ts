// wallet-auth.ts -- EIP-191 signature verification, nonce management, session tokens

import { randomUUID } from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

// --- Nonce store (5-minute expiry) ---

interface NonceEntry {
  createdAt: number;
  used: boolean;
}

const NONCE_TTL_MS = 5 * 60 * 1000;
const nonces = new Map<string, NonceEntry>();

export function generateNonce(): string {
  const nonce = randomUUID().replace(/-/g, "");
  nonces.set(nonce, { createdAt: Date.now(), used: false });
  return nonce;
}

export function consumeNonce(nonce: string): boolean {
  const entry = nonces.get(nonce);
  if (!entry) return false;
  if (entry.used) return false;
  if (Date.now() - entry.createdAt > NONCE_TTL_MS) {
    nonces.delete(nonce);
    return false;
  }
  entry.used = true;
  nonces.delete(nonce);
  return true;
}

// Periodic cleanup of expired nonces
setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of nonces) {
    if (now - entry.createdAt > NONCE_TTL_MS) {
      nonces.delete(nonce);
    }
  }
}, 60_000);

// --- Session token store ---

interface SessionEntry {
  address: string; // lowercase checksumless Ethereum address
  createdAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map<string, SessionEntry>();

export function createSession(address: string): string {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  sessions.set(token, { address: address.toLowerCase(), createdAt: Date.now() });
  return token;
}

export function getSessionAddress(token: string): string | null {
  const entry = sessions.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return entry.address;
}

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of sessions) {
    if (now - entry.createdAt > SESSION_TTL_MS) {
      sessions.delete(token);
    }
  }
}, 5 * 60_000);

// --- EIP-191 signature verification ---

function hashPersonalMessage(msg: string): Uint8Array {
  const msgBytes = Buffer.from(msg, "utf8");
  const prefix = Buffer.from(
    "\x19Ethereum Signed Message:\n" + msgBytes.length,
    "utf8"
  );
  const prefixed = Buffer.concat([prefix, msgBytes]);
  return keccak_256(prefixed);
}

export function recoverAddress(message: string, sigHex: string): string {
  const msgHash = hashPersonalMessage(message);

  const sigBuf = Buffer.from(sigHex.replace(/^0x/, ""), "hex");
  if (sigBuf.length !== 65) {
    throw new Error(`signature must be 65 bytes, got ${sigBuf.length}`);
  }

  const compact64 = sigBuf.slice(0, 64); // r(32) + s(32)
  const v = sigBuf[64]; // 27 or 28
  const recovery = v >= 27 ? v - 27 : v; // normalize to 0 or 1

  const sigObj = secp256k1.Signature.fromBytes(compact64).addRecoveryBit(
    recovery
  );
  const pubKeyPoint = sigObj.recoverPublicKey(msgHash);
  const pubKeyBytes = pubKeyPoint.toRawBytes(false); // 65-byte uncompressed: 0x04 + x(32) + y(32)

  // Ethereum address = last 20 bytes of keccak256(pubkey without 0x04 prefix)
  const addrHash = keccak_256(pubKeyBytes.slice(1));
  return "0x" + Buffer.from(addrHash.slice(-20)).toString("hex");
}

export function verifySignature(
  message: string,
  signature: string,
  expectedAddress: string
): boolean {
  try {
    const recovered = recoverAddress(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

// Build the message the wallet signs
export function buildSignMessage(nonce: string): string {
  return `Sign in to SynthMob\n\nNonce: ${nonce}`;
}

// --- Reset (for admin/testing) ---

export function resetWalletAuth(): void {
  nonces.clear();
  sessions.clear();
}
