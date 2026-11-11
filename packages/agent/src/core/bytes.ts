// A copy of what the agent needs from Outis's wallet core (its `@outis/core`, not published): the same
// declarations word for word, so that what is hashed and sent reads one way in the wallet and in the
// agent. Change it only as the wallet's changes.

const MASK_128 = (1n << 128n) - 1n;

/** Cairo serializes a u256 as two felts: low 128 bits, then high 128 bits. */
export function u256ToFelts(value: bigint): [bigint, bigint] {
  if (value < 0n || value >> 256n !== 0n) throw new RangeError("u256 out of range");
  return [value & MASK_128, value >> 128n];
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n || value >> BigInt(length * 8) !== 0n) throw new RangeError(`value does not fit in ${length} bytes`);
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && bytesEqual(bytes.subarray(0, prefix.length), prefix);
}

/** base64url without padding, as WebAuthn uses for challenges and credential ids. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/** 0x-prefixed, zero-padded to 64 hex digits (the form addresses and hashes are shown in). */
export function toPaddedHex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/**
 * An address as the wallet shows it short: its 64-digit form's first eight characters and last six
 * ("0x04f8d5…8d37f4"), five useful digits at the start (the first is always 0) and six at the end
 * (user, 2026-10-26). Padded, so its digits stand where other wallets and explorers show them; a
 * passkey's name is the same (passkeyName), so the user matches one to the other by eye.
 */
export function shortAddress(address: bigint): string {
  const hex = toPaddedHex(address);
  return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}
