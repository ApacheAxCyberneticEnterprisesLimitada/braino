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

export interface RepositoryLinksRequest {
  repositories: Array<{
    id: string;
    files: CodeGraphSourceFile[];
  }>;
}

export interface RepositoryLinksOutput {
  stats: {
    repositories: number;
    source_files: number;
    links: number;
    build_ms: number;
  };
  links: Array<{
    from: string;
    to: string;
    relation: "CALLS_SERVICE" | "REPOSITORY";
    confidence: "exact";
    evidence: Array<{
      file: string;
      line: number;
      kind: string;
      text: string;
    }>;
  }>;
}

export interface CodeGraphClient {
  /** Changes force an unchanged repository snapshot through extraction again. */
  readonly id: string;
  createGraph(input: CodeGraphRequest): Promise<CodeGraphOutput>;
  createRepositoryLinks(input: RepositoryLinksRequest): Promise<RepositoryLinksOutput>;
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
const REPOSITORY_RELATIONSHIPS = new Set(["CALLS_SERVICE", "REPOSITORY"]);
const REPOSITORY_GRAPH_EXTERNAL_ID = "__repositories__";
const REPOSITORY_LINKS_EXTRACTION_VERSION = "repository-links-v1";
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
    throw new Error("BRAINO_CODELINKER_URL must use http or https");
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

function repositoryLinksOutput(
  value: unknown,
  request: RepositoryLinksRequest,
): RepositoryLinksOutput {
  if (!value || typeof value !== "object") throw new Error("Invalid repository links response");
  const raw = value as Record<string, unknown>;
  if (!raw.stats || typeof raw.stats !== "object") {
    throw new Error("Invalid repository links stats");
  }
  if (!Array.isArray(raw.links)) throw new Error("Invalid repository links collection");
  const stats = raw.stats as Record<string, unknown>;
  const repositories = new Map(
    request.repositories.map((repository) => [
      repository.id,
      new Set(repository.files.map((file) => file.path)),
    ]),
  );
  const links = raw.links.map((link, index) => {
    if (!link || typeof link !== "object") throw new Error(`Invalid repository link ${index}`);
    const item = link as Record<string, unknown>;
    const from = string(item.from, `repository link ${index} source`);
    const to = string(item.to, `repository link ${index} target`);
    const relation = string(item.relation, `repository link ${index} relation`);
    const confidence = string(item.confidence, `repository link ${index} confidence`);
    if (!repositories.has(from) || !repositories.has(to)) {
      throw new Error(`Repository link ${index} references an unknown repository`);
    }
    if (!REPOSITORY_RELATIONSHIPS.has(relation)) {
      throw new Error(`Repository link ${index} has unsupported relation ${relation}`);
    }
    if (confidence !== "exact") {
      throw new Error(`Repository link ${index} has invalid confidence`);
    }
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
      throw new Error(`Repository link ${index} has no evidence`);
    }
    const evidence = item.evidence.map((rawEvidence, evidenceIndex) => {
      if (!rawEvidence || typeof rawEvidence !== "object") {
        throw new Error(`Invalid evidence ${evidenceIndex} for repository link ${index}`);
      }
      const candidate = rawEvidence as Record<string, unknown>;
      const file = string(candidate.file, `repository link ${index} evidence file`);
      const line = number(candidate.line, `repository link ${index} evidence line`);
      if (!repositories.get(from)?.has(file)) {
        throw new Error(`Repository link ${index} evidence references an unknown file`);
      }
      if (!Number.isInteger(line) || line < 1) {
        throw new Error(`Repository link ${index} evidence has an invalid line`);
      }
      return {
        file,
        line,
        kind: string(candidate.kind, `repository link ${index} evidence kind`),
        text: string(candidate.text, `repository link ${index} evidence text`),
      };
    });
    return {
      from,
      to,
      relation: relation as RepositoryLinksOutput["links"][number]["relation"],
      confidence: confidence as "exact",
      evidence,
    };
  });
  return {
    stats: {
      repositories: number(stats.repositories, "repositories"),
      source_files: number(stats.source_files, "source_files"),
      links: number(stats.links, "links"),
      build_ms: number(stats.build_ms, "build_ms"),
    },
    links,
  };
}

export class HttpCodeGraphClient implements CodeGraphClient {
  readonly id = "codelinker:tree-sitter-v1";
  readonly #url: string;
  readonly #apiToken: string;
  readonly #timeoutMs: number;

  constructor(options: { url: string; apiToken: string; timeoutMs?: number }) {
    this.#url = graphUrl(options.url);
    this.#apiToken = options.apiToken.trim();
    if (!this.#apiToken) throw new Error("BRAINO_CODELINKER_API_TOKEN cannot be blank");
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

  async createRepositoryLinks(input: RepositoryLinksRequest): Promise<RepositoryLinksOutput> {
    const response = await fetch(`${this.#url}/v1/repository-links`, {
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
    return repositoryLinksOutput(await response.json(), input);
  }
}

export function configuredCodeGraphClient(
  env: Record<string, string | undefined> = process.env,
): CodeGraphClient | null {
  const url = env.BRAINO_CODELINKER_URL?.trim();
  const apiToken = env.BRAINO_CODELINKER_API_TOKEN?.trim();
  if (!url && !apiToken) return null;
  if (!url) throw new Error("BRAINO_CODELINKER_URL is required when CodeLinker is configured");
  if (!apiToken) {
    throw new Error("BRAINO_CODELINKER_API_TOKEN is required when CodeLinker is configured");
  }
  return new HttpCodeGraphClient({
    url,
    apiToken,
    timeoutMs: positiveInteger(
      env.BRAINO_CODELINKER_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      "BRAINO_CODELINKER_TIMEOUT_MS",
    ),
  });
}

interface StoredCodeFile {
  path: string;
  sha: string;
  content: string;
}

interface StoredCollectionCodeFile extends StoredCodeFile {
  repo: string;
}

function language(path: string): CodeGraphLanguage | null {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".scala")) return "scala";
  return null;
}

function snapshotManifest(files: StoredCodeFile[]): string {
  return files.map((file) => `${file.path}\t${file.sha}`).join("\n");
}

function repositoryLinkSource(file: StoredCodeFile): boolean {
  const extension = file.path.toLowerCase().split(".").pop() ?? "";
  return (
    extension === "java" ||
    ["conf", "env", "json", "properties", "toml", "xml", "yaml", "yml"].includes(extension) ||
    /https?:\/\/github\.com\//i.test(file.content)
  );
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
 * Build one repository-level derived document from Braino's durable code mirror.
 * The connector still owns GitHub access; the parser receives only normalized
 * source already stored by Braino. A SHA manifest makes unchanged pushes free.
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

/**
 * Build the collection-wide repository map from the same durable code mirror.
 * Only files that can provide exact repository evidence cross the service
 * boundary; every repository identity remains present so aliases resolve.
 */
export async function syncCodeGraphCollection(
  c: QueryClient,
  args: { collectionId: string; client: CodeGraphClient },
): Promise<CodeGraphSyncResult> {
  const stored = (
    await c.query<StoredCollectionCodeFile>(
      `SELECT repo, path, sha, content
         FROM code_files
        WHERE collection_id = $1 AND omitted IS NULL
        ORDER BY repo, path`,
      [args.collectionId],
    )
  ).rows;
  const repositories = new Map<string, StoredCodeFile[]>();
  for (const file of stored) {
    const files = repositories.get(file.repo) ?? [];
    if (repositoryLinkSource(file)) {
      files.push({ path: file.path, sha: file.sha, content: file.content });
    }
    repositories.set(file.repo, files);
  }

  if (repositories.size < 2) {
    await deleteCodeGraphDocument(c, args.collectionId, REPOSITORY_GRAPH_EXTERNAL_ID);
    return { status: "deleted", files: 0, edges: 0 };
  }

  const snapshots = [...repositories]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, files]) => ({
      id,
      files: files.map(({ path, content }) => ({ path, content })),
    }));
  const sourceFiles = [...repositories.values()].flat();
  const manifest = snapshots
    .flatMap((repository) => [
      `repository\t${repository.id}`,
      ...(repositories.get(repository.id) ?? []).map(
        (file) => `file\t${repository.id}\t${file.path}\t${file.sha}`,
      ),
    ])
    .join("\n");
  const extractionId = `${args.client.id}:${REPOSITORY_LINKS_EXTRACTION_VERSION}`;
  const current = (
    await c.query<{ content_hash: string; extraction_id: string; edges: number }>(
      `SELECT d.content_hash, d.extraction_id, count(r.id)::int AS edges
         FROM retrieval_documents d
         LEFT JOIN retrieval_chunks ch ON ch.document_id = d.id
         LEFT JOIN retrieval_relations r ON r.source_chunk_id = ch.id
        WHERE d.collection_id = $1 AND d.source = 'code_graph' AND d.external_id = $2
        GROUP BY d.id, d.content_hash, d.extraction_id`,
      [args.collectionId, REPOSITORY_GRAPH_EXTERNAL_ID],
    )
  ).rows[0];
  if (current?.content_hash === hash(manifest) && current.extraction_id === extractionId) {
    return { status: "unchanged", files: sourceFiles.length, edges: current.edges };
  }

  const output = await args.client.createRepositoryLinks({ repositories: snapshots });
  const entityByRepository = new Map<
    string,
    {
      key: string;
      name: string;
      type: string;
      description: string;
      mentions: Array<{ chunkIndex: number }>;
    }
  >();
  const relationships = output.links.map((link, chunkIndex) => {
    for (const repository of [link.from, link.to]) {
      const entity = entityByRepository.get(repository) ?? {
        key: repository,
        name: repository,
        type: "code_repository",
        description: "Code repository",
        mentions: [],
      };
      entity.mentions.push({ chunkIndex });
      entityByRepository.set(repository, entity);
    }
    const evidence = link.evidence
      .map((item) => `${link.from}/${item.file}:${item.line} — ${item.text}`)
      .join("; ");
    return {
      fromKey: link.from,
      toKey: link.to,
      type: link.relation,
      fact: `${link.from} ${link.relation} ${link.to}. Evidence: ${evidence}`,
      chunkIndex,
      confidence: 1,
    };
  });
  const chunks =
    relationships.length > 0
      ? relationships.map((relationship) => ({
          text: relationship.fact,
          breadcrumb: "Repository code graph",
        }))
      : [
          {
            text: "No exact inter-repository relationships were resolved.",
            breadcrumb: "Repository code graph",
          },
        ];

  const report = await ingestRetrievalDocument(c, {
    collectionId: args.collectionId,
    source: "code_graph",
    externalId: REPOSITORY_GRAPH_EXTERNAL_ID,
    title: "Repository code graph",
    content: manifest,
    accessScopes: ["workspace"],
    chunks,
    extraction: { entities: [...entityByRepository.values()], relationships },
  });
  await c.query("UPDATE retrieval_documents SET extraction_id = $1 WHERE id = $2", [
    extractionId,
    report.documentId,
  ]);
  return { status: "indexed", files: sourceFiles.length, edges: relationships.length };
}
