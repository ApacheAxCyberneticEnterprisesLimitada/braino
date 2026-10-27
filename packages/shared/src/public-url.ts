// Doco's hosts. The public site has one base, `DOCO_PUBLIC_HOST` (default
// https://doco.to), and every workspace lives on a subdomain of it:
// `<handle>.doco.to` is the workspace, `<handle>.doco.to/<collection>` one of its
// collections, and the base host keeps the host-level pages (sign-in, the list
// of workspaces, /agents, /mcp, /api/v1). One route table serves every host, so
// anything that links across hosts builds an absolute URL from the base here.

export const DEFAULT_PUBLIC_BASE_URL = "https://doco.to";

/** The public site's base URL, without a trailing slash: `DOCO_PUBLIC_HOST`,
 *  else https://doco.to. Links in emails, Slack and agent instructions start
 *  from it, never from the deployment that happened to serve a request. */
export function publicBaseUrl(): string {
  const override = process.env.DOCO_PUBLIC_HOST?.trim();
  return (override || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "");
}

/** `https://<handle>.doco.to` for the base https://doco.to. */
export function workspaceOrigin(base: string, workspaceHandle: string): string {
  // Built as text, not through URL's hostname setter, so a placeholder such as
  // `<handle>` in instructions renders too.
  const { protocol, host } = new URL(base);
  return `${protocol}//${workspaceHandle}.${host}`;
}

/** A page of a workspace: `https://<handle>.doco.to<path>`; `path` starts with `/`. */
export function workspaceUrl(base: string, workspaceHandle: string, path = "/"): string {
  return `${workspaceOrigin(base, workspaceHandle)}${path === "/" ? "" : path}`;
}

/** A page of a collection: `https://<workspace>.doco.to/<collection><path>`. */
export function collectionUrl(
  base: string,
  workspaceHandle: string,
  collectionHandle: string,
  path = "",
): string {
  return `${workspaceOrigin(base, workspaceHandle)}/${collectionHandle}${path}`;
}

/** The handle of the workspace a request's host names, `<handle>` of
 *  `<handle>.<base host>`, or null on the base host and on any other host (a
 *  deployment's own vercel.app address, a tunnel). */
export function workspaceHandleFromHost(host: string, base: string): string | null {
  const baseHost = new URL(base).host.toLowerCase();
  const requested = host.trim().toLowerCase();
  if (!requested.endsWith(`.${baseHost}`)) return null;
  const label = requested.slice(0, -(baseHost.length + 1));
  return /^[a-z0-9][a-z0-9_-]*$/.test(label) ? label : null;
}
