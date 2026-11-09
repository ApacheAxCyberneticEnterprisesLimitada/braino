import type { PasswordAttemptBucket } from "@doco/host";

export function passwordAttemptBuckets(request: Request, email: string): PasswordAttemptBucket[] {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return [
    { scope: "client", identifier: forwarded || "direct", maxAttempts: 30 },
    { scope: "account", identifier: email.trim().toLowerCase() || "missing", maxAttempts: 5 },
  ];
}
