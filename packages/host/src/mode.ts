import { existsSync } from "node:fs";
import { join } from "node:path";

export type EvaloRootMode = "host" | "single-evalo" | "empty";

/**
 * ADR-061 dual-mode detection. A directory is a Host if it has `host.yaml` at
 * the root; a single Evalo if it has `evalo.yaml`; otherwise undetermined.
 */
export function detectMode(root: string): EvaloRootMode {
  if (existsSync(join(root, "host.yaml"))) return "host";
  if (existsSync(join(root, "evalo.yaml"))) return "single-evalo";
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

export function hostEvalosDir(root: string): string {
  return join(root, "evalos");
}

export function hostSchemaPath(root: string): string {
  return join(root, "schema", "evalo.schema.json");
}

export function hostEvaloDir(root: string, ownerSlug: string, evaloSlug: string): string {
  return join(root, "evalos", ownerSlug, evaloSlug);
}
