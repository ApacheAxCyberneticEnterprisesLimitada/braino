import { describe, expect, it } from "vitest";
import { createSessionCookie, readSessionUserId } from "./session.server.js";

const env = {
  DOCO_ENCRYPTION_KEY: "this-is-a-test-key-with-at-least-thirty-two-characters",
  DOCO_PUBLIC_HOST: "https://doco.example",
};

describe("sessions", () => {
  it("round-trips the signed user id in an HTTP-only cookie", () => {
    const cookie = createSessionCookie("user_owner", env, new Date("2026-01-01T00:00:00Z"));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");

    const request = new Request("https://doco.example", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    expect(readSessionUserId(request, env, new Date("2026-01-02T00:00:00Z"))).toBe("user_owner");
  });

  it("rejects tampered and expired cookies", () => {
    const cookie = createSessionCookie("user_owner", env, new Date("2026-01-01T00:00:00Z"));
    const pair = cookie.split(";")[0] ?? "";
    const tampered = new Request("https://doco.example", {
      headers: { cookie: `${pair}x` },
    });
    expect(readSessionUserId(tampered, env, new Date("2026-01-02T00:00:00Z"))).toBeNull();

    const expired = new Request("https://doco.example", { headers: { cookie: pair } });
    expect(readSessionUserId(expired, env, new Date("2026-02-15T00:00:00Z"))).toBeNull();
  });
});
