import { describe, expect, it } from "vitest";
import { compareIso, isIsoDateTime, nowIso } from "../time.js";

describe("nowIso", () => {
  it("returns a valid ISO 8601 UTC string ending with Z", () => {
    const v = nowIso();
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("isIsoDateTime", () => {
  it("accepts UTC Z suffix", () => {
    expect(isIsoDateTime("2026-05-08T15:42:00Z")).toBe(true);
    expect(isIsoDateTime("2026-05-08T15:42:00.000Z")).toBe(true);
  });

  it("accepts numeric offset", () => {
    expect(isIsoDateTime("2026-05-08T15:42:00+02:00")).toBe(true);
  });

  it("rejects bare date", () => {
    expect(isIsoDateTime("2026-05-08")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isIsoDateTime(0)).toBe(false);
    expect(isIsoDateTime(null)).toBe(false);
    expect(isIsoDateTime(undefined)).toBe(false);
  });
});

describe("compareIso", () => {
  it("orders timestamps chronologically", () => {
    expect(compareIso("2026-05-08T15:42:00Z", "2026-05-08T15:42:01Z")).toBeLessThan(0);
    expect(compareIso("2026-05-08T15:42:01Z", "2026-05-08T15:42:00Z")).toBeGreaterThan(0);
    expect(compareIso("2026-05-08T15:42:00Z", "2026-05-08T15:42:00Z")).toBe(0);
  });
});
