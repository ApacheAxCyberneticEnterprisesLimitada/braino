import { readFile, writeFile } from "node:fs/promises";
import matter from "gray-matter";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { EntityFileFormat } from "./paths.js";

// gray-matter ships with js-yaml 1.x which rejects some valid-but-edge-case YAML
// (e.g., colon-space inside backticks in unquoted list items). Wire the
// spec-compliant `yaml` 2.x package as its engine so all our YAML parsing goes
// through the same parser.
const matterOptions = {
  engines: {
    yaml: {
      parse: (s: string) => parseYaml(s) ?? {},
      stringify: (v: object) => stringifyYaml(v),
    },
  },
} as const;

/**
 * One entity stored in one file. The structured fields live in `data`; for `.md`
 * files the prose body lives in `body` (empty string otherwise).
 */
export interface ParsedEntityFile {
  data: Record<string, unknown>;
  body: string;
  format: EntityFileFormat;
}

/** Read and parse an entity file. Format is inferred from the extension. */
export async function readEntityFile(path: string): Promise<ParsedEntityFile> {
  const content = await readFile(path, "utf8");
  return parseEntityContent(content, formatFromPath(path));
}

export function parseEntityContent(content: string, format: EntityFileFormat): ParsedEntityFile {
  switch (format) {
    case "md": {
      const parsed = matter(content, matterOptions);
      return {
        data: parsed.data as Record<string, unknown>,
        body: parsed.content,
        format,
      };
    }
    case "yaml": {
      const data = parseYaml(content) as Record<string, unknown> | null;
      return { data: data ?? {}, body: "", format };
    }
    case "json": {
      const data = JSON.parse(content) as Record<string, unknown>;
      return { data, body: "", format };
    }
  }
}

export function serializeEntityContent(parsed: ParsedEntityFile): string {
  switch (parsed.format) {
    case "md":
      // gray-matter's stringify doesn't preserve user's preferred formatting for arbitrary data;
      // build a clean frontmatter + body manually.
      return `---\n${stringifyYaml(parsed.data)}---\n\n${parsed.body.trimStart()}`;
    case "yaml":
      return stringifyYaml(parsed.data);
    case "json":
      return `${JSON.stringify(parsed.data, null, 2)}\n`;
  }
}

export async function writeEntityFile(path: string, parsed: ParsedEntityFile): Promise<void> {
  const content = serializeEntityContent(parsed);
  await writeFile(path, content, "utf8");
}

function formatFromPath(path: string): EntityFileFormat {
  if (path.endsWith(".md")) return "md";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".json")) return "json";
  throw new Error(`Cannot infer entity-file format from path: ${path}`);
}
