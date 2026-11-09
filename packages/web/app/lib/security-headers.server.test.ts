import { describe, expect, it } from "vitest";
import { securityHeaders } from "./security-headers.server.js";

describe("application security headers", () => {
  it("protects direct application responses without relying on Caddy", () => {
    expect(securityHeaders).toMatchObject({
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
  });
});
