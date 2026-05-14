export * from "./branded.js";
export * from "./ulid.js";
export * from "./time.js";
export * from "./entities.js";
export * from "./public-url.js";
export * from "./url-conventions.js";
// Absorbed from @doco/core (dissolved 2026-05-14 — see audit reasoning_01KRM4R2S0WPV0CSK9H812A022 #3).
//
// files.ts and paths.ts use `node:fs/promises` and `node:path` at module
// top-level — they break the browser bundle if star-re-exported, because
// Rollup walks the barrel and tries to resolve `readFile` against the
// vite-browser-external shim (which exports nothing). No external consumer
// uses their runtime exports today (verified by repo-wide grep on
// readEntityFile / writeEntityFile / parseEntityContent / docoYamlPath /
// entityDirPath / glossaryPath / entityFilenameRegex / ENTITY_DIRS). Their
// types (ParsedEntityFile, EntityFileFormat, EntityDirSpec) are also unused
// externally — sibling shared modules import them via relative paths.
//
// If you ever need to expose them, deep-import from "@doco/shared/dist/files.js"
// (server-side only) or add a "@doco/shared/server" subpath export to
// package.json — do NOT add them back here.
export * from "./loaded-doco.js";
export * from "./refs.js";
export * from "./scope-rules.js";
export * from "./validate.js";
