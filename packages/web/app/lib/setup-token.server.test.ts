import { describe, expect, it } from "vitest";
import { setupTokenError } from "./setup-token.server.js";

const configured = "setup-token-with-at-least-thirty-two-characters";

describe("the first-run setup token", () => {
  it("accepts only the configured token", () => {
    expect(setupTokenError(configured, { DOCO_SETUP_TOKEN: configured })).toBeNull();
    expect(setupTokenError("wrong-token", { DOCO_SETUP_TOKEN: configured })).toBe(
      "Setup token is incorrect.",
    );
  });

  it("fails closed when the deployment has no strong setup token", () => {
    expect(setupTokenError(configured, {})).toMatch(/DOCO_SETUP_TOKEN/);
    expect(setupTokenError(configured, { DOCO_SETUP_TOKEN: "short" })).toMatch(
      /at least 32 characters/,
    );
  });
});
