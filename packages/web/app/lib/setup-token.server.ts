import { timingSafeEqual } from "node:crypto";

interface SetupEnvironment {
  DOCO_SETUP_TOKEN?: string;
}

export function setupTokenError(
  supplied: string,
  env: SetupEnvironment = process.env,
): string | null {
  const expected = env.DOCO_SETUP_TOKEN?.trim();
  if (!expected || expected.length < 32) {
    return "DOCO_SETUP_TOKEN must contain at least 32 characters before first-run setup.";
  }
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied.trim());
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return "Setup token is incorrect.";
  }
  return null;
}
