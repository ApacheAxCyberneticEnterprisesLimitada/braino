import { generateKeyPairSync } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { connectConnector, syncConnectorConnection } from "../connectors.js";
import { googleDriveConnector } from "../connectors/google-drive.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const scope = <T>(operation: (client: PoolClient) => Promise<T>) => operation(client());
const encryptionKey = "drive-connector-test-key-with-more-than-thirty-two-characters";
const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const credential = JSON.stringify({
  type: "service_account",
  project_id: "acme-knowledge",
  private_key_id: "test-key",
  private_key: privateKey,
  client_email: "doco@acme-knowledge.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
});

async function fixture() {
  return initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
}

interface DriveState {
  edited: boolean;
  includeFiles: boolean;
  oversized?: boolean;
}

function fakeDrive(state: DriveState): typeof fetch {
  return (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      expect(body.get("assertion")?.split(".")).toHaveLength(3);
      return Response.json({
        access_token: "drive-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer drive-access-token");
    if (url.pathname === "/drive/v3/about") {
      return Response.json({
        user: {
          displayName: "Acme Knowledge",
          emailAddress: "doco@acme-knowledge.iam.gserviceaccount.com",
          permissionId: "permission_acme",
        },
      });
    }
    if (url.pathname === "/drive/v3/files" && !url.searchParams.has("alt")) {
      return Response.json({
        nextPageToken: null,
        files: state.includeFiles
          ? [
              {
                id: "doc_runbook",
                name: "Incident runbook",
                mimeType: "application/vnd.google-apps.document",
                createdTime: "2026-11-01T10:00:00.000Z",
                modifiedTime: state.edited
                  ? "2026-11-02T10:00:00.000Z"
                  : "2026-11-01T10:00:00.000Z",
                webViewLink: "https://docs.google.com/document/d/doc_runbook/edit",
              },
              {
                id: "sheet_owners",
                name: "Service owners",
                mimeType: "application/vnd.google-apps.spreadsheet",
                createdTime: "2026-11-01T11:00:00.000Z",
                modifiedTime: "2026-11-01T11:00:00.000Z",
                webViewLink: "https://docs.google.com/spreadsheets/d/sheet_owners/edit",
              },
              {
                id: "text_notes",
                name: "release-notes.txt",
                mimeType: "text/plain",
                size: "64",
                createdTime: "2026-11-01T12:00:00.000Z",
                modifiedTime: "2026-11-01T12:00:00.000Z",
                webViewLink: "https://drive.google.com/file/d/text_notes/view",
              },
              {
                id: "folder_ops",
                name: "Operations",
                mimeType: "application/vnd.google-apps.folder",
                createdTime: "2026-11-01T09:00:00.000Z",
                modifiedTime: "2026-11-01T09:00:00.000Z",
              },
              {
                id: "image_logo",
                name: "logo.png",
                mimeType: "image/png",
                size: "1024",
                createdTime: "2026-11-01T09:00:00.000Z",
                modifiedTime: "2026-11-01T09:00:00.000Z",
              },
            ]
          : [],
      });
    }
    if (url.pathname === "/drive/v3/files/doc_runbook/export") {
      expect(url.searchParams.get("mimeType")).toBe("text/markdown");
      return new Response(
        state.edited
          ? "# Recovery\n\nRestore the latest verified backup."
          : "# Recovery\n\nRestore the latest backup.",
        state.oversized ? { headers: { "content-length": String(11 * 1024 * 1024) } } : undefined,
      );
    }
    if (url.pathname === "/drive/v3/files/sheet_owners/export") {
      expect(url.searchParams.get("mimeType")).toBe("text/csv");
      return new Response("service,owner\napi,Ana");
    }
    if (url.pathname === "/drive/v3/files/text_notes" && url.searchParams.get("alt") === "media") {
      return new Response("Release completed without rollback.");
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("Google Drive connector", () => {
  it("uses a sealed service account to import searchable Workspace and text files", async () => {
    const setup = await fixture();
    const state: DriveState = { edited: false, includeFiles: true };
    const connection = await connectConnector(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      credential,
      encryptionKey,
      adapter: googleDriveConnector,
      fetcher: fakeDrive(state),
    });
    expect(connection).toMatchObject({
      provider: "google_drive",
      sourceId: "permission_acme",
      sourceName: "Acme Knowledge",
      collectionHandle: "acme-google-drive",
    });
    const stored = await db.query<{ credential_sealed: string }>(
      "SELECT credential_sealed FROM connector_connections WHERE id = $1",
      [connection.id],
    );
    expect(stored.rows[0]?.credential_sealed).not.toContain("PRIVATE KEY");

    expect(
      await syncConnectorConnection(scope, {
        connectionId: connection.id,
        encryptionKey,
        adapter: googleDriveConnector,
        fetcher: fakeDrive(state),
      }),
    ).toEqual({ created: 3, updated: 0, retired: 0, unchanged: 0 });
    const nodes = await db.query<{ prose: string; extra: Record<string, unknown> }>(
      "SELECT prose, extra FROM nodes ORDER BY locator",
    );
    expect(nodes.rows).toHaveLength(3);
    expect(nodes.rows.some((node) => node.prose.includes("Restore the latest backup."))).toBe(true);
    expect(nodes.rows.some((node) => node.prose.includes("service,owner"))).toBe(true);
    expect(nodes.rows.some((node) => node.prose.includes("Release completed"))).toBe(true);
    expect(nodes.rows.every((node) => node.extra.connector_provider === "google_drive")).toBe(true);

    expect(
      await syncConnectorConnection(scope, {
        connectionId: connection.id,
        encryptionKey,
        adapter: googleDriveConnector,
        fetcher: fakeDrive(state),
      }),
    ).toEqual({ created: 0, updated: 0, retired: 0, unchanged: 3 });
    state.edited = true;
    expect(
      await syncConnectorConnection(scope, {
        connectionId: connection.id,
        encryptionKey,
        adapter: googleDriveConnector,
        fetcher: fakeDrive(state),
      }),
    ).toEqual({ created: 0, updated: 1, retired: 0, unchanged: 2 });

    state.includeFiles = false;
    expect(
      await syncConnectorConnection(scope, {
        connectionId: connection.id,
        encryptionKey,
        adapter: googleDriveConnector,
        fetcher: fakeDrive(state),
      }),
    ).toEqual({ created: 0, updated: 0, retired: 3, unchanged: 0 });
  });

  it("rejects an exported file before buffering a declared oversized body", async () => {
    const setup = await fixture();
    const state: DriveState = { edited: false, includeFiles: true, oversized: true };
    const connection = await connectConnector(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      credential,
      encryptionKey,
      adapter: googleDriveConnector,
      fetcher: fakeDrive(state),
    });

    await expect(
      syncConnectorConnection(scope, {
        connectionId: connection.id,
        encryptionKey,
        adapter: googleDriveConnector,
        fetcher: fakeDrive(state),
      }),
    ).rejects.toMatchObject({ code: "source_too_large", status: 422 });
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM nodes")).rows[0]?.n).toBe(
      0,
    );
  });
});
