import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectionUrl,
  publicBaseUrl,
  workspaceHandleFromHost,
  workspaceOrigin,
  workspaceUrl,
} from "../public-url.js";

afterEach(() => vi.unstubAllEnvs());

describe("publicBaseUrl", () => {
  it("is https://doco.to unless DOCO_PUBLIC_HOST says otherwise", () => {
    vi.stubEnv("DOCO_PUBLIC_HOST", undefined);
    expect(publicBaseUrl()).toBe("https://doco.to");
    vi.stubEnv("DOCO_PUBLIC_HOST", "");
    expect(publicBaseUrl()).toBe("https://doco.to");
  });

  it("honors DOCO_PUBLIC_HOST, without its trailing slash", () => {
    vi.stubEnv("DOCO_PUBLIC_HOST", "http://doco.localhost:5173/");
    expect(publicBaseUrl()).toBe("http://doco.localhost:5173");
  });
});

describe("workspace and collection URLs", () => {
  it("puts the workspace on a subdomain of the base", () => {
    expect(workspaceOrigin("https://doco.to", "meta-doco")).toBe("https://meta-doco.doco.to");
    expect(workspaceUrl("https://doco.to", "meta-doco")).toBe("https://meta-doco.doco.to");
    expect(workspaceUrl("https://doco.to", "meta-doco", "/settings")).toBe(
      "https://meta-doco.doco.to/settings",
    );
  });

  it("keeps the base's scheme and port", () => {
    expect(workspaceUrl("http://doco.localhost:5173", "acme", "/agent")).toBe(
      "http://acme.doco.localhost:5173/agent",
    );
  });

  it("renders a placeholder handle, for instructions that show the URL's shape", () => {
    expect(workspaceUrl("https://doco.to", "<handle>")).toBe("https://<handle>.doco.to");
  });

  it("puts a collection under its workspace's host", () => {
    expect(collectionUrl("https://doco.to", "meta-doco", "meta-doco-design-decisions")).toBe(
      "https://meta-doco.doco.to/meta-doco-design-decisions",
    );
    expect(
      collectionUrl("https://doco.to", "acme", "acme-bugs", "/api/decisions.json?limit=5"),
    ).toBe("https://acme.doco.to/acme-bugs/api/decisions.json?limit=5");
  });
});

describe("workspaceHandleFromHost", () => {
  it("reads the workspace from the first label under the base host", () => {
    expect(workspaceHandleFromHost("meta-doco.doco.to", "https://doco.to")).toBe("meta-doco");
    expect(workspaceHandleFromHost("Acme.doco.to", "https://doco.to")).toBe("acme");
    expect(workspaceHandleFromHost("acme.doco.localhost:5173", "http://doco.localhost:5173")).toBe(
      "acme",
    );
  });

  it("names no workspace on the base host or on another host", () => {
    expect(workspaceHandleFromHost("doco.to", "https://doco.to")).toBeNull();
    expect(workspaceHandleFromHost("doco-git-x.vercel.app", "https://doco.to")).toBeNull();
    expect(workspaceHandleFromHost("localhost:5173", "https://doco.to")).toBeNull();
    expect(workspaceHandleFromHost("doco.to", "http://doco.localhost:5173")).toBeNull();
  });

  it("names no workspace for a label that is not a handle", () => {
    expect(workspaceHandleFromHost("a.b.doco.to", "https://doco.to")).toBeNull();
    expect(workspaceHandleFromHost("-x.doco.to", "https://doco.to")).toBeNull();
  });
});
