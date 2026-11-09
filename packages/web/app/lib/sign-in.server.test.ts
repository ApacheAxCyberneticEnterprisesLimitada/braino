import { describe, expect, it } from "vitest";
import { passwordAttemptBuckets } from "./sign-in.server.js";

describe("sign-in attempt identity", () => {
  it("limits both the normalized account and Caddy's client address", () => {
    const request = new Request("https://doco.example", {
      headers: { "x-forwarded-for": "203.0.113.4" },
    });
    expect(passwordAttemptBuckets(request, " Owner@Example.COM ")).toEqual([
      { scope: "client", identifier: "203.0.113.4", maxAttempts: 30 },
      { scope: "account", identifier: "owner@example.com", maxAttempts: 5 },
    ]);
  });

  it("uses one conservative direct-access bucket when no proxy address exists", () => {
    expect(
      passwordAttemptBuckets(new Request("http://localhost:3000"), "a@example.com")[0],
    ).toEqual({ scope: "client", identifier: "direct", maxAttempts: 30 });
  });
});
