import { describe, expect, it } from "vitest";
import { isUlid } from "../branded.js";
import { generateUlid, ulidTimestamp } from "../ulid.js";

describe("ULID generation", () => {
  it("produces 26-character Crockford base32 strings", () => {
    const u = generateUlid();
    expect(u).toHaveLength(26);
    expect(isUlid(u)).toBe(true);
  });

  it("produces unique values across many calls", () => {
    const set = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      set.add(generateUlid());
    }
    expect(set.size).toBe(10_000);
  });

  it("encodes the supplied timestamp recoverably via ulidTimestamp", () => {
    const ts = 1778254920000; // 2026-05-08T15:42:00Z
    const u = generateUlid(ts);
    expect(ulidTimestamp(u).getTime()).toBe(ts);
  });

  it("uses only Crockford alphabet characters (no I, L, O, U)", () => {
    for (let i = 0; i < 100; i++) {
      const u = generateUlid();
      expect(u).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it("ULIDs from the same millisecond differ in their random suffix", () => {
    const ts = 1778254920000;
    const a = generateUlid(ts);
    const b = generateUlid(ts);
    // Same timestamp prefix
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    // Different randomness suffix
    expect(a.slice(10)).not.toBe(b.slice(10));
  });

  it("matches the format of the bootstrap ULIDs (e.g. doco_id)", () => {
    // Sanity: a known good bootstrap ULID validates.
    expect(isUlid("01KR441EA0ZDMF0N5DY38GSVS3")).toBe(true);
  });
});
