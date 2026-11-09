import { describe, expect, it } from "vitest";
import { createSessionCookie, readSessionIdentity } from "./session.server.js";

const env = {
  DOCO_ENCRYPTION_KEY: "this-is-a-test-key-with-at-least-thirty-two-characters",
  DOCO_PUBLIC_HOST: "https://doco.example",
};

describe("sessions", () => {
  it("round-trips the signed user id and revocation stamp in an HTTP-only cookie", () => {
    const cookie = createSessionCookie(
      { userId: "user_owner", stamp: "stamp_1" },
      env,
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");

    const request = new Request("https://doco.example", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    expect(readSessionIdentity(request, env, new Date("2026-01-02T00:00:00Z"))).toEqual({
      userId: "user_owner",
      stamp: "stamp_1",
    });
  });

  it("rejects tampered and expired cookies", () => {
    const cookie = createSessionCookie(
      { userId: "user_owner", stamp: "stamp_1" },
      env,
      new Date("2026-01-01T00:00:00Z"),
    );
    const pair = cookie.split(";")[0] ?? "";
    const tampered = new Request("https://doco.example", {
      headers: { cookie: `${pair}x` },
    });
    expect(readSessionIdentity(tampered, env, new Date("2026-01-02T00:00:00Z"))).toBeNull();

    const expired = new Request("https://doco.example", { headers: { cookie: pair } });
    expect(readSessionIdentity(expired, env, new Date("2026-02-15T00:00:00Z"))).toBeNull();
  });
});
