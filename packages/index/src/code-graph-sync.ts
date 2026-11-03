import { createHash } from "node:crypto";
import { type QueryClient, ingestRetrievalDocument } from "@doco/db";

export type CodeGraphLanguage = "python" | "scala";

export interface CodeGraphSourceFile {
  path: string;
  content: string;
}

export interface CodeGraphRequest {
  language: CodeGraphLanguage;
  files: CodeGraphSourceFile[];
}

export interface CodeGraphOutput {
  stats: {
    language: CodeGraphLanguage;
    source_files: number;
    parsed_files: number;
    parse_errors: number;
    symbols: number;
    edges: number;
    build_ms: number;
  };
  files: Array<{ path: string; symbols: string[] }>;
  edges: Array<{
    from: string;
    to: string;
    type: "IMPORTS" | "REFERENCES" | "CALLS" | "EXTENDS" | "ROUTES_TO";
    label: string;
    confidence: "exact" | "heuristic";
  }>;
}

export interface CodeGraphClient {
  /** Changes force an unchanged repository snapshot through extraction again. */
  readonly id: string;
  createGraph(input: CodeGraphRequest): Promise<CodeGraphOutput>;
}

export interface CodeGraphSyncResult {
  status: "indexed" | "unchanged" | "deleted";
  files: number;
  edges: number;
}

const CODE_GRAPH_RELATIONSHIPS = new Set([
  "IMPORTS",
  "REFERENCES",
  "CALLS",
  "EXTENDS",
  "ROUTES_TO",
]);
const DEFAULT_TIMEOUT_MS = 120_000;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function graphUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("DOCO_CODE_GRAPH_URL must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid code graph ${name}`);
  return value;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid code graph ${name}`);
  }
  return value;
}

function graphOutput(value: unknown, request: CodeGraphRequest): CodeGraphOutput {
  if (!value || typeof value !== "object") throw new Error("Invalid code graph response");
  const raw = value as Record<string, unknown>;
  if (!raw.stats || typeof raw.stats !== "object") throw new Error("Invalid code graph stats");
  const stats = raw.stats as Record<string, unknown>;
  if (!Array.isArray(raw.files) || !Array.isArray(raw.edges)) {
    throw new Error("Invalid code graph response collections");
  }
  const requestedPaths = new Set(request.files.map((file) => file.path));
  const files = raw.files.map((file, index) => {
    if (!file || typeof file !== "object") throw new Error(`Invalid code graph file ${index}`);
    const item = file as Record<string, unknown>;
    const path = string(item.path, `file ${index} path`);
    if (!requestedPaths.has(path) || !Array.isArray(item.symbols)) {
      throw new Error(`Invalid code graph file ${path}`);
    }
    return {
      path,
      symbols: item.symbols.map((symbol) => string(symbol, `symbol in ${path}`)),
    };
  });
  const edges = raw.edges.map((edge, index) => {
    if (!edge || typeof edge !== "object") throw new Error(`Invalid code graph edge ${index}`);
    const item = edge as Record<string, unknown>;
    const from = string(item.from, `edge ${index} source`);
    const to = string(item.to, `edge ${index} target`);
    const type = string(item.type, `edge ${index} type`);
    const confidence = string(item.confidence, `edge ${index} confidence`);
    if (!requestedPaths.has(from) || !requestedPaths.has(to)) {
      throw new Error(`Code graph edge ${index} references an unknown file`);
    }
    if (!CODE_GRAPH_RELATIONSHIPS.has(type)) {
      throw new Error(`Code graph edge ${index} has unsupported type ${type}`);
    }
    if (confidence !== "exact" && confidence !== "heuristic") {
      throw new Error(`Code graph edge ${index} has invalid confidence`);
    }
    return {
      from,
      to,
      type: type as CodeGraphOutput["edges"][number]["type"],
      label: string(item.label, `edge ${index} label`),
      confidence: confidence as CodeGraphOutput["edges"][number]["confidence"],
    };
  });
  return {
    stats: {
      language: request.language,
      source_files: number(stats.source_files, "source_files"),
      parsed_files: number(stats.parsed_files, "parsed_files"),
      parse_errors: number(stats.parse_errors, "parse_errors"),
      symbols: number(stats.symbols, "symbols"),
      edges: number(stats.edges, "edges"),
      build_ms: number(stats.build_ms, "build_ms"),
    },
    files,
    edges,
  };
}

export class HttpCodeGraphClient implements CodeGraphClient {
  readonly id = "code-graph:tree-sitter-v1";
  readonly #url: string;
  readonly #apiToken: string;
  readonly #timeoutMs: number;

  constructor(options: { url: string; apiToken: string; timeoutMs?: number }) {
    this.#url = graphUrl(options.url);
    this.#apiToken = options.apiToken.trim();
    if (!this.#apiToken) throw new Error("DOCO_CODE_GRAPH_API_TOKEN cannot be blank");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async createGraph(input: CodeGraphRequest): Promise<CodeGraphOutput> {
    const response = await fetch(`${this.#url}/v1/graphs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      const message = (await response.text()).slice(0, 500);
      throw new Error(`Code graph service failed with HTTP ${response.status}: ${message}`);
    }
    return graphOutput(await response.json(), input);
  }
}

export function configuredCodeGraphClient(
  env: Record<string, string | undefined> = process.env,
): CodeGraphClient | null {
  const url = env.DOCO_CODE_GRAPH_URL?.trim();
  const apiToken = env.DOCO_CODE_GRAPH_API_TOKEN?.trim();
  if (!url && !apiToken) return null;
  if (!url) throw new Error("DOCO_CODE_GRAPH_URL is required when code graph sync is configured");
  if (!apiToken) {
    throw new Error("DOCO_CODE_GRAPH_API_TOKEN is required when code graph sync is configured");
  }
  return new HttpCodeGraphClient({
    url,
    apiToken,
    timeoutMs: positiveInteger(
      env.DOCO_CODE_GRAPH_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      "DOCO_CODE_GRAPH_TIMEOUT_MS",
    ),
  });
}

interface StoredCodeFile {
  path: string;
  sha: string;
  content: string;
}

function language(path: string): CodeGraphLanguage | null {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".scala")) return "scala";
  return null;
}

function snapshotManifest(files: StoredCodeFile[]): string {
  return files.map((file) => `${file.path}\t${file.sha}`).join("\n");
}

function hash(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

async function deleteCodeGraphDocument(
  c: QueryClient,
  collectionId: string,
  repo: string,
): Promise<void> {
  await c.query("BEGIN");
  try {
    await c.query("SELECT id FROM collections WHERE id = $1 FOR UPDATE", [collectionId]);
    await c.query(
      `DELETE FROM retrieval_documents
        WHERE collection_id = $1 AND source = 'code_graph' AND external_id = $2`,
      [collectionId, repo],
    );
    await c.query(
      `DELETE FROM retrieval_entities e
        WHERE e.collection_id = $1
          AND NOT EXISTS (SELECT 1 FROM retrieval_mentions m WHERE m.entity_id = e.id)
          AND NOT EXISTS (
            SELECT 1 FROM retrieval_relations r
             WHERE r.from_entity_id = e.id OR r.to_entity_id = e.id
          )`,
      [collectionId],
    );
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  }
}

/**
 * Build one repository-level derived document from Doco's durable code mirror.
 * The connector still owns GitHub access; the parser receives only normalized
 * source already stored by Doco. A SHA manifest makes unchanged pushes free.
 */
export async function syncCodeGraphRepository(
  c: QueryClient,
  args: { collectionId: string; repo: string; client: CodeGraphClient },
): Promise<CodeGraphSyncResult> {
  const files = (
    await c.query<StoredCodeFile>(
      `SELECT path, sha, content
         FROM code_files
        WHERE collection_id = $1 AND repo = $2 AND omitted IS NULL
        ORDER BY path`,
      [args.collectionId, args.repo],
    )
  ).rows.filter((file) => language(file.path));

  if (files.length === 0) {
    await deleteCodeGraphDocument(c, args.collectionId, args.repo);
    return { status: "deleted", files: 0, edges: 0 };
  }

  const manifest = snapshotManifest(files);
  const current = (
    await c.query<{ content_hash: string; extraction_id: string; edges: number }>(
      `SELECT d.content_hash, d.extraction_id, count(r.id)::int AS edges
         FROM retrieval_documents d
         LEFT JOIN retrieval_chunks ch ON ch.document_id = d.id
         LEFT JOIN retrieval_relations r ON r.source_chunk_id = ch.id
        WHERE d.collection_id = $1 AND d.source = 'code_graph' AND d.external_id = $2
        GROUP BY d.id, d.content_hash, d.extraction_id`,
      [args.collectionId, args.repo],
    )
  ).rows[0];
  if (current?.content_hash === hash(manifest) && current.extraction_id === args.client.id) {
    return { status: "unchanged", files: files.length, edges: current.edges };
  }

  const outputs: CodeGraphOutput[] = [];
  for (const graphLanguage of ["python", "scala"] as const) {
    const languageFiles = files.filter((file) => language(file.path) === graphLanguage);
    if (languageFiles.length === 0) continue;
    outputs.push(
      await args.client.createGraph({
        language: graphLanguage,
        files: languageFiles.map(({ path, content }) => ({ path, content })),
      }),
    );
  }

  const edges = outputs
    .flatMap((output) => output.edges)
    .filter((edge) => edge.from !== edge.to)
    .filter(
      (edge, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.from === edge.from &&
            candidate.to === edge.to &&
            candidate.type === edge.type &&
            candidate.label === edge.label,
        ) === index,
    )
    .sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.type.localeCompare(b.type) ||
        a.label.localeCompare(b.label),
    );

  const entityByPath = new Map<
    string,
    {
      key: string;
      name: string;
      type: string;
      description: string;
      mentions: Array<{ chunkIndex: number }>;
    }
  >();
  const relationships = edges.map((edge, chunkIndex) => {
    for (const path of [edge.from, edge.to]) {
      const entity = entityByPath.get(path) ?? {
        key: path,
        name: `${args.repo}/${path}`,
        type: "code_file",
        description: `Code file in ${args.repo}`,
        mentions: [],
      };
      if (!entity.mentions.some((mention) => mention.chunkIndex === chunkIndex)) {
        entity.mentions.push({ chunkIndex });
      }
      entityByPath.set(path, entity);
    }
    return {
      fromKey: edge.from,
      toKey: edge.to,
      type: edge.type,
      fact: `${args.repo}/${edge.from} ${edge.type} ${args.repo}/${edge.to} via ${edge.label}.`,
      chunkIndex,
      confidence: edge.confidence === "exact" ? 1 : 0.75,
    };
  });
  const chunks =
    relationships.length > 0
      ? relationships.map((relationship) => ({
          text: relationship.fact,
          breadcrumb: `${args.repo} code graph`,
        }))
      : [
          {
            text: `No resolved cross-file relationships in ${args.repo}.`,
            breadcrumb: `${args.repo} code graph`,
          },
        ];

  const report = await ingestRetrievalDocument(c, {
    collectionId: args.collectionId,
    source: "code_graph",
    externalId: args.repo,
    locator: `https://github.com/${args.repo}`,
    title: `${args.repo} code graph`,
    content: manifest,
    accessScopes: ["workspace"],
    chunks,
    extraction: { entities: [...entityByPath.values()], relationships },
  });
  await c.query("UPDATE retrieval_documents SET extraction_id = $1 WHERE id = $2", [
    args.client.id,
    report.documentId,
  ]);
  return { status: "indexed", files: files.length, edges: relationships.length };
}
