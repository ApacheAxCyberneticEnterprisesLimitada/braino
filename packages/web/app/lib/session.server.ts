import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "doco_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

interface SessionEnvironment {
  DOCO_ENCRYPTION_KEY?: string;
  DOCO_PUBLIC_HOST?: string;
}

interface SessionPayload {
  sub: string;
  stamp: string;
  exp: number;
}

export interface SessionIdentity {
  userId: string;
  stamp: string;
}

function key(env: SessionEnvironment): string {
  const value = env.DOCO_ENCRYPTION_KEY?.trim();
  if (!value || value.length < 32) {
    throw new Error("DOCO_ENCRYPTION_KEY must contain at least 32 characters.");
  }
  return value;
}

function signature(payload: string, env: SessionEnvironment): string {
  return createHmac("sha256", key(env)).update(payload).digest("base64url");
}

function secure(env: SessionEnvironment): boolean {
  return env.DOCO_PUBLIC_HOST?.trim().startsWith("https://") ?? false;
}

export function createSessionCookie(
  identity: SessionIdentity,
  env: SessionEnvironment = process.env,
  now = new Date(),
): string {
  const data: SessionPayload = {
    sub: identity.userId,
    stamp: identity.stamp,
    exp: Math.floor(now.getTime() / 1000) + SESSION_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const value = `${payload}.${signature(payload, env)}`;
  return [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_SECONDS}`,
    ...(secure(env) ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(env: SessionEnvironment = process.env): string {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure(env) ? ["Secure"] : []),
  ].join("; ");
}

function cookieValue(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=") || null;
  }
  return null;
}

export function readSessionIdentity(
  request: Request,
  env: SessionEnvironment = process.env,
  now = new Date(),
): SessionIdentity | null {
  try {
    const value = cookieValue(request);
    if (!value) return null;
    const [payload, supplied] = value.split(".");
    if (!payload || !supplied) return null;
    const expected = Buffer.from(signature(payload, env));
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionPayload;
    if (!parsed.sub || !parsed.stamp || !Number.isFinite(parsed.exp)) return null;
    if (parsed.exp <= Math.floor(now.getTime() / 1000)) return null;
    return { userId: parsed.sub, stamp: parsed.stamp };
  } catch {
    return null;
  }
}
