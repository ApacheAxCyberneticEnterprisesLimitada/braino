import type { Ulid } from "./branded.js";

/**
 * Crockford base32 ULID generation per https://github.com/ulid/spec.
 * 26 characters: 10-char timestamp (48-bit ms since epoch) + 16-char randomness (80 bits).
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIMESTAMP_LEN = 10;
const RANDOMNESS_LEN = 16;
const RANDOMNESS_BYTES = 10; // 80 bits / 8
const RANDOMNESS_SPACE = 1n << BigInt(RANDOMNESS_BYTES * 8);

let lastAutoTimestampMs = -1;
let lastAutoRandom = 0n;

function encodeBigInt(value: bigint, length: number): string {
  let v = value;
  const out: string[] = new Array(length);
  for (let i = length - 1; i >= 0; i--) {
    const digit = Number(v & 0x1fn);
    out[i] = ALPHABET[digit] as string;
    v >>= 5n;
  }
  return out.join("");
}

function randomBigInt(byteCount: number): bigint {
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) | BigInt(b);
  }
  return result;
}

/**
 * Generate a ULID. Optional fixed-time millisecond timestamp lets callers produce
 * deterministic-time ULIDs (used by tests and the bootstrap ULID generator).
 */
export function generateUlid(timestampMs?: number): Ulid {
  let tsNumber = timestampMs ?? Date.now();
  let rand = randomBigInt(RANDOMNESS_BYTES);

  if (timestampMs === undefined) {
    if (tsNumber < lastAutoTimestampMs) {
      tsNumber = lastAutoTimestampMs;
    }
    if (tsNumber === lastAutoTimestampMs) {
      lastAutoRandom += 1n;
      if (lastAutoRandom >= RANDOMNESS_SPACE) {
        tsNumber += 1;
        lastAutoTimestampMs = tsNumber;
        lastAutoRandom = 0n;
      }
      rand = lastAutoRandom;
    } else {
      lastAutoTimestampMs = tsNumber;
      lastAutoRandom = rand;
    }
  }

  const ts = BigInt(tsNumber);
  return (encodeBigInt(ts, TIMESTAMP_LEN) + encodeBigInt(rand, RANDOMNESS_LEN)) as Ulid;
}

/** Decode the timestamp portion of a ULID into a Date. */
export function ulidTimestamp(ulid: Ulid): Date {
  const tsPart = ulid.slice(0, TIMESTAMP_LEN);
  let ms = 0n;
  for (const ch of tsPart) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) {
      throw new Error(`Invalid ULID character: ${ch}`);
    }
    ms = (ms << 5n) | BigInt(digit);
  }
  return new Date(Number(ms));
}
