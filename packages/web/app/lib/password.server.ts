import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const MIN_LENGTH = 12;
const MAX_LENGTH = 200;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

export function passwordError(password: string): string | null {
  if (password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters.`;
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

let decoyHash: Promise<string> | null = null;

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  decoyHash ??= hashPassword("not anyone's password");
  const [scheme, salt, key] = (hash ?? (await decoyHash)).split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  const matches = timingSafeEqual(await derive(password, Buffer.from(salt, "base64url")), expected);
  return matches && hash !== null;
}
