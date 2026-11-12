import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./safe-return-path";

describe("safeReturnPath", () => {
  it("preserves a local OAuth authorization request", () => {
    expect(safeReturnPath("/oauth/authorize?client_id=braino&state=one")).toBe(
      "/oauth/authorize?client_id=braino&state=one",
    );
  });

  it("rejects absolute, protocol-relative, and backslash redirects", () => {
    expect(safeReturnPath("https://attacker.example")).toBe("/");
    expect(safeReturnPath("//attacker.example/path")).toBe("/");
    expect(safeReturnPath("/\\attacker.example/path")).toBe("/");
  });
});
