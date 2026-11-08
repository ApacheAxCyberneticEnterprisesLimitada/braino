import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const AAD = Buffer.from("doco:integration-secret:v1");

function key(encryptionKey: string): Buffer {
  const normalized = encryptionKey.trim();
  if (normalized.length < 32) {
    throw new Error("DOCO_ENCRYPTION_KEY must contain at least 32 characters.");
  }
  return createHash("sha256").update(normalized).digest();
}

export function sealSecret(secret: string, encryptionKey: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(encryptionKey), nonce);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [
    VERSION,
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function openSecret(sealed: string, encryptionKey: string): string {
  const [version, nonce, tag, encrypted] = sealed.split(".");
  if (version !== VERSION || !nonce || !tag || !encrypted) {
    throw new Error("The encrypted integration credential is invalid.");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(encryptionKey),
      Buffer.from(nonce, "base64url"),
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("The encrypted integration credential cannot be opened.");
  }
}
