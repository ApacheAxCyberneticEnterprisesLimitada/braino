import { createSign } from "node:crypto";
import {
  type ConnectorAdapter,
  type ConnectorDocument,
  ConnectorError,
  type ConnectorFetcher,
  type ConnectorSource,
} from "@doco/host";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const MAX_TEXT_BYTES = 10 * 1024 * 1024;

interface ServiceAccount {
  type: "service_account";
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
  subject?: string;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
}

function parseServiceAccount(credential: string): ServiceAccount {
  let value: unknown;
  try {
    value = JSON.parse(credential);
  } catch {
    throw new ConnectorError(
      "Paste a Google service-account JSON credential.",
      "credential_invalid",
    );
  }
  if (!value || typeof value !== "object") {
    throw new ConnectorError(
      "The Google service-account credential is invalid.",
      "credential_invalid",
    );
  }
  const account = value as Partial<ServiceAccount>;
  if (
    account.type !== "service_account" ||
    !account.project_id?.trim() ||
    !account.client_email?.trim() ||
    !account.private_key?.includes("PRIVATE KEY")
  ) {
    throw new ConnectorError(
      "The Google credential must be a service-account JSON key.",
      "credential_invalid",
    );
  }
  if (account.token_uri && account.token_uri !== TOKEN_URI) {
    throw new ConnectorError("The Google token endpoint is not supported.", "credential_invalid");
  }
  return account as ServiceAccount;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function serviceAccountAssertion(account: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url({
    alg: "RS256",
    typ: "JWT",
    ...(account.private_key_id ? { kid: account.private_key_id } : {}),
  });
  const claims = base64url({
    iss: account.client_email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URI,
    iat: now - 30,
    exp: now + 3_600,
    ...(account.subject?.trim() ? { sub: account.subject.trim() } : {}),
  });
  const unsigned = `${header}.${claims}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(account.private_key, "base64url")}`;
  } catch {
    throw new ConnectorError(
      "The Google service-account private key is invalid.",
      "credential_invalid",
    );
  }
}

async function accessToken(fetcher: ConnectorFetcher, account: ServiceAccount): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: serviceAccountAssertion(account),
  });
  const response = await fetcher(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const value = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    error_description?: unknown;
  };
  if (!response.ok || typeof value.access_token !== "string") {
    const detail =
      typeof value.error_description === "string" ? `: ${value.error_description}` : "";
    throw new ConnectorError(
      `Google rejected the service-account credential${detail}.`,
      "google_auth_failed",
      502,
    );
  }
  return value.access_token;
}

async function driveResponse(
  fetcher: ConnectorFetcher,
  path: string,
  token: string,
): Promise<Response> {
  const response = await fetcher(`${DRIVE_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "doco-self-hosted" },
  });
  if (!response.ok) {
    let detail = "";
    try {
      const value = (await response.json()) as { error?: { message?: unknown } };
      const message = value.error?.message;
      detail = typeof message === "string" ? `: ${message}` : "";
    } catch {
      // The status is still enough to produce an operator-safe error.
    }
    throw new ConnectorError(
      response.status === 401 || response.status === 403
        ? "Google Drive rejected the service account or cannot read the shared files."
        : `Google Drive returned HTTP ${response.status}${detail}.`,
      "google_drive_request_failed",
      502,
    );
  }
  return response;
}

async function driveJson<T>(fetcher: ConnectorFetcher, path: string, token: string): Promise<T> {
  return (await (await driveResponse(fetcher, path, token)).json()) as T;
}

async function driveIdentity(
  fetcher: ConnectorFetcher,
  token: string,
): Promise<{ id: string; name: string; email: string }> {
  const about = await driveJson<{
    user?: { displayName?: unknown; emailAddress?: unknown; permissionId?: unknown };
  }>(fetcher, "/about?fields=user(displayName,emailAddress,permissionId)", token);
  const email = about.user?.emailAddress;
  const permissionId = about.user?.permissionId;
  if (typeof email !== "string" || typeof permissionId !== "string") {
    throw new ConnectorError(
      "Google Drive returned an invalid account identity.",
      "source_invalid",
      502,
    );
  }
  return {
    id: permissionId,
    name:
      typeof about.user?.displayName === "string" && about.user.displayName.trim()
        ? about.user.displayName
        : email,
    email,
  };
}

async function verify(input: {
  credential: string;
  fetcher: ConnectorFetcher;
}): Promise<ConnectorSource> {
  const account = parseServiceAccount(input.credential);
  const token = await accessToken(input.fetcher, account);
  const identity = await driveIdentity(input.fetcher, token);
  return {
    id: identity.id,
    name: identity.name,
    config: {
      service_account_email: identity.email,
      project_id: account.project_id,
      ...(account.subject?.trim() ? { delegated_subject: account.subject.trim() } : {}),
    },
  };
}

async function* files(fetcher: ConnectorFetcher, token: string): AsyncGenerator<DriveFile> {
  let pageToken: string | null = null;
  for (let page = 0; page < 1_000; page += 1) {
    const query = new URLSearchParams({
      q: "trashed = false",
      spaces: "drive",
      pageSize: "1000",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      fields: "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,webViewLink,size)",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const value: { files?: DriveFile[]; nextPageToken?: string | null } = await driveJson(
      fetcher,
      `/files?${query}`,
      token,
    );
    if (!Array.isArray(value.files)) {
      throw new ConnectorError(
        "Google Drive returned an invalid file list.",
        "source_invalid",
        502,
      );
    }
    for (const file of value.files) yield file;
    pageToken = value.nextPageToken?.trim() || null;
    if (!pageToken) return;
  }
  throw new ConnectorError(
    "Google Drive pagination exceeded 1,000,000 files.",
    "source_too_large",
    422,
  );
}

const EXPORT_TYPES: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/sql",
]);

function downloadableText(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_APPLICATION_TYPES.has(mimeType);
}

async function limitedText(response: Response, name: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TEXT_BYTES) {
    throw new ConnectorError(`${name} exceeds the 10 MB connector limit.`, "source_too_large", 422);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_TEXT_BYTES) {
      await reader.cancel();
      throw new ConnectorError(
        `${name} exceeds the 10 MB connector limit.`,
        "source_too_large",
        422,
      );
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fileText(
  fetcher: ConnectorFetcher,
  token: string,
  file: DriveFile & { id: string; name: string; mimeType: string },
): Promise<string | null> {
  const exportType = EXPORT_TYPES[file.mimeType];
  if (exportType) {
    const query = new URLSearchParams({ mimeType: exportType });
    return limitedText(
      await driveResponse(fetcher, `/files/${encodeURIComponent(file.id)}/export?${query}`, token),
      file.name,
    );
  }
  if (!downloadableText(file.mimeType)) return null;
  const size = file.size ? Number(file.size) : 0;
  if (Number.isFinite(size) && size > MAX_TEXT_BYTES) {
    throw new ConnectorError(
      `${file.name} exceeds the 10 MB connector limit.`,
      "source_too_large",
      422,
    );
  }
  return limitedText(
    await driveResponse(fetcher, `/files/${encodeURIComponent(file.id)}?alt=media`, token),
    file.name,
  );
}

async function* documents(input: {
  credential: string;
  source: ConnectorSource;
  fetcher: ConnectorFetcher;
}): AsyncGenerator<ConnectorDocument> {
  const account = parseServiceAccount(input.credential);
  const token = await accessToken(input.fetcher, account);
  for await (const file of files(input.fetcher, token)) {
    if (
      !file.id ||
      !file.name ||
      !file.mimeType ||
      !file.createdTime ||
      !file.modifiedTime ||
      file.mimeType === "application/vnd.google-apps.folder"
    ) {
      continue;
    }
    const content = await fileText(
      input.fetcher,
      token,
      file as DriveFile & {
        id: string;
        name: string;
        mimeType: string;
      },
    );
    if (content === null) continue;
    yield {
      externalId: file.id,
      title: file.name,
      content: content.trim() || file.name,
      url: file.webViewLink ?? `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`,
      createdAt: file.createdTime,
      updatedAt: file.modifiedTime,
      metadata: { mime_type: file.mimeType },
    };
  }
}

export const googleDriveConnector: ConnectorAdapter = {
  provider: "google_drive",
  verify,
  documents,
};
