import { existsSync } from "node:fs";
import { join } from "node:path";

export type DocoRootMode = "host" | "single-doco" | "empty";

/**
 * ADR-061 dual-mode detection. A directory is a Host if it has `host.yaml` at
 * the root; a single Doco if it has `doco.yaml`; otherwise undetermined.
 */
export function detectMode(root: string): DocoRootMode {
  if (existsSync(join(root, "host.yaml"))) return "host";
  if (existsSync(join(root, "doco.yaml"))) return "single-doco";
  return "empty";
}

export function hostYamlPath(root: string): string {
  return join(root, "host.yaml");
}

export function hostPrincipalsDir(root: string): string {
  return join(root, "principals");
}

export function hostOrganizationsDir(root: string): string {
  return join(root, "organizations");
}

export function hostDocosDir(root: string): string {
  return join(root, "docos");
}

export function hostDocoDir(root: string, ownerSlug: string, docoSlug: string): string {
  return join(root, "docos", ownerSlug, docoSlug);
}
