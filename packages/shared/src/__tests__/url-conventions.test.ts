import { describe, expect, it } from "vitest";
import { validateRequestedDocoHandle } from "../url-conventions.js";

describe("validateRequestedDocoHandle", () => {
  it.each(["terms", "sign-up", "agents"])("reserves %s, a top-level host route", (handle) => {
    expect(validateRequestedDocoHandle(handle)).toMatch(/is reserved/);
  });

  it("accepts an ordinary handle", () => {
    expect(validateRequestedDocoHandle("acme-decisions")).toBeNull();
  });
});
