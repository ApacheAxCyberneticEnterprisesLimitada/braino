// Returns the public base URL the host should advertise in shareable artifacts
// (invitation URLs, claim URLs, "tell your agent" copyable messages, etc.).
//
// Resolution order:
//   1. `DOCO_PUBLIC_HOST` env var, if set. Use this when the dev server is
//      accessed through a tunnel (ngrok, Cloudflare Tunnel) so that URLs
//      shared with off-machine agents are reachable. Strips trailing slash.
//   2. The host from the incoming request — works for same-machine browser
//      access at e.g. http://127.0.0.1:5173.
//
// Per the DOCO_PUBLIC_HOST escape hatch decision (Phase 10 follow-up).

export function getPublicBaseUrl(request: Request): string {
  const override = process.env.DOCO_PUBLIC_HOST;
  if (override) return override.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
