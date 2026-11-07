import { describe, expect, it } from "vitest";
import { hashPassword, passwordError, verifyPassword } from "./password.server.js";

describe("passwords", () => {
  it("stores a salted scrypt hash and verifies only the original password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$[^$]+\$[^$]+$/);
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong horse battery staple", hash)).resolves.toBe(false);
  });

  it("requires a useful first-run password", () => {
    expect(passwordError("short")).toBe("Use at least 12 characters.");
    expect(passwordError("long enough password")).toBeNull();
  });
});
