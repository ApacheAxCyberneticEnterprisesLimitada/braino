import { describe, expect, it } from "vitest";
import { validateRequestedCollectionHandle } from "../url-conventions.js";

describe("validateRequestedCollectionHandle", () => {
  it.each(["terms", "sign-up", "agents"])("reserves %s, a top-level host route", (handle) => {
    expect(validateRequestedCollectionHandle(handle)).toMatch(/is reserved/);
  });

  it("accepts an ordinary handle", () => {
    expect(validateRequestedCollectionHandle("acme-decisions")).toBeNull();
  });
});
