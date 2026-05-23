import { afterEach, describe, expect, it } from "vitest";
import { getPublicBaseUrl } from "../public-url.js";

const original = process.env.DOCO_PUBLIC_HOST;

afterEach(() => {
  if (original === undefined) process.env.DOCO_PUBLIC_HOST = undefined;
  else process.env.DOCO_PUBLIC_HOST = original;
});

describe("getPublicBaseUrl", () => {
  it("returns scheme://host from the request when DOCO_PUBLIC_HOST is unset", () => {
    process.env.DOCO_PUBLIC_HOST = undefined;
    const req = new Request("http://127.0.0.1:5173/some/path?q=1");
    expect(getPublicBaseUrl(req)).toBe("http://127.0.0.1:5173");
  });

  it("honors DOCO_PUBLIC_HOST when set, ignoring the request host", () => {
    process.env.DOCO_PUBLIC_HOST = "https://doco.dev";
    const req = new Request("http://127.0.0.1:5173/anything");
    expect(getPublicBaseUrl(req)).toBe("https://doco.dev");
  });

  it("strips a trailing slash from DOCO_PUBLIC_HOST", () => {
    process.env.DOCO_PUBLIC_HOST = "https://doco.dev/";
    const req = new Request("http://127.0.0.1:5173/");
    expect(getPublicBaseUrl(req)).toBe("https://doco.dev");
  });

  it("preserves a non-trailing path segment in DOCO_PUBLIC_HOST (sub-path tunneling)", () => {
    process.env.DOCO_PUBLIC_HOST = "https://tunnel.example.com/doco";
    const req = new Request("http://127.0.0.1:5173/");
    expect(getPublicBaseUrl(req)).toBe("https://tunnel.example.com/doco");
  });

  it("works with https requests when DOCO_PUBLIC_HOST is unset", () => {
    process.env.DOCO_PUBLIC_HOST = undefined;
    const req = new Request("https://example.com:8443/x");
    expect(getPublicBaseUrl(req)).toBe("https://example.com:8443");
  });

  it("ignores empty DOCO_PUBLIC_HOST (treats as unset)", () => {
    process.env.DOCO_PUBLIC_HOST = "";
    const req = new Request("http://127.0.0.1:5173/y");
    expect(getPublicBaseUrl(req)).toBe("http://127.0.0.1:5173");
  });
});
