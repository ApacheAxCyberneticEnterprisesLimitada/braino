import { afterEach, describe, expect, it, vi } from "vitest";
import { databasePoolConfig } from "../client.js";

const DATABASE_URL = "postgresql://doco:secret@db.example.test:6432/doco";

afterEach(() => vi.unstubAllEnvs());

describe("databasePoolConfig", () => {
  it("configures verified TLS and a bounded serverless pool", () => {
    vi.stubEnv("DOCO_DATABASE_URL", DATABASE_URL);
    vi.stubEnv("DOCO_DATABASE_CA", "CA\\nCERT");
    vi.stubEnv("DOCO_DATABASE_CERT", "CLIENT\\nCERT");
    vi.stubEnv("DOCO_DATABASE_KEY", "CLIENT\\nKEY");
    vi.stubEnv("DOCO_DATABASE_POOL_MAX", "3");

    expect(databasePoolConfig()).toEqual({
      connectionString: DATABASE_URL,
      max: 3,
      ssl: {
        ca: "CA\nCERT",
        cert: "CLIENT\nCERT",
        key: "CLIENT\nKEY",
        rejectUnauthorized: true,
      },
    });
  });

  it("rejects partial TLS client credentials", () => {
    vi.stubEnv("DOCO_DATABASE_URL", DATABASE_URL);
    vi.stubEnv("DOCO_DATABASE_CA", "CA");
    vi.stubEnv("DOCO_DATABASE_CERT", "CLIENT CERT");

    expect(() => databasePoolConfig()).toThrow(
      "DOCO_DATABASE_CERT and DOCO_DATABASE_KEY must be configured together",
    );
  });

  it("rejects an invalid pool limit", () => {
    vi.stubEnv("DOCO_DATABASE_URL", DATABASE_URL);
    vi.stubEnv("DOCO_DATABASE_POOL_MAX", "0");

    expect(() => databasePoolConfig()).toThrow("DOCO_DATABASE_POOL_MAX must be between 1 and 100");
  });
});
