// Rebuildable retrieval graph over connector evidence. The authored Doco graph
// remains the source of governance truth; these rows provide Falkor-style
// document/chunk provenance, entity resolution, mentions, and relationship
// traversal for retrieval.

import { createHash } from "node:crypto";
import {
  type EmbeddingProviderLike,
  type EmbeddingsReport,
  type QueryClient,
  type SemanticQuery,
  rankEmbeddings,
  upsertEmbeddings,
} from "./embeddings.js";

export interface RetrievalChunkInput {
  text: string;
  breadcrumb?: string | null;
}

export interface RetrievalMentionInput {
  chunkIndex: number;
  startOffset?: number;
  endOffset?: number | null;
  confidence?: number;
}

export interface RetrievalEntityInput {
  /** Document-local extraction key used by relationships. */
  key: string;
  name: string;
  type: string;
  aliases?: string[];
  description?: string | null;
  mentions: RetrievalMentionInput[];
}

export interface RetrievalRelationshipInput {
  fromKey: string;
  toKey: string;
  type: string;
  fact: string;
  chunkIndex: number;
  confidence?: number;
}

export interface RetrievalDocumentInput {
  collectionId: string;
  source: string;
  externalId: string;
  locator?: string | null;
  title?: string | null;
  content: string;
  accessScopes?: string[];
  chunks: RetrievalChunkInput[];
  extraction: {
    entities: RetrievalEntityInput[];
    relationships: RetrievalRelationshipInput[];
  };
}

export interface RetrievalIngestReport {
  documentId: string;
  chunkIds: string[];
  entityIds: string[];
  relationIds: string[];
  embeddings?: EmbeddingsReport;
}

export interface RetrievalChunkRow {
  id: string;
  document_id: string;
  source: string;
  external_id: string;
  locator: string | null;
  title: string | null;
  chunk_index: number;
  text: string;
  breadcrumb: string | null;
}

export interface RetrievalEntityHit {
  id: string;
  name: string;
  entity_type: string;
  rank: number;
  exact: boolean;
}

export interface RetrievalRelationRow {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  fact: string;
  source_chunk_id: string;
  confidence: number;
}

export interface RetrievalRelationExpansion extends RetrievalRelationRow {
  hop: number;
}

function digest(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

/** Matches PostgreSQL's built-in md5(text), used by the unified source view
 * to find documents whose derived retrieval copy is stale. */
function contentHash(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${digest(value).slice(0, 26)}`;
}

export function normalizeRetrievalEntityName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value)),
  ];
}

function canonicalNormalizedName(entity: RetrievalEntityInput): string {
  const candidates = uniqueStrings([entity.name, ...(entity.aliases ?? [])])
    .map(normalizeRetrievalEntityName)
    .filter(Boolean)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (candidates.length === 0) throw new Error(`Entity ${entity.key} has no usable name`);
  return candidates[0];
}

/**
 * Replace one connector document's derived retrieval graph. Exact resolution
 * is by normalized name/type, including aliases; provenance remains one
 * mention/relationship row per source chunk. The caller may wrap this in its
 * wider connector transaction.
 */
export async function ingestRetrievalDocument(
  c: QueryClient,
  input: RetrievalDocumentInput,
  opts: { embeddingProvider?: EmbeddingProviderLike } = {},
): Promise<RetrievalIngestReport> {
  if (input.chunks.length === 0) throw new Error("Retrieval document requires at least one chunk");
  const accessScopes = uniqueStrings(input.accessScopes ?? ["workspace"]);
  if (accessScopes.length === 0) throw new Error("Retrieval document requires an access scope");
  const documentId = stableId(
    "rtdoc",
    `${input.collectionId}\n${input.source}\n${input.externalId}`,
  );

  // Deleting the old document cascades through chunks, mentions, relations,
  // and their embedding cleanup triggers. Canonical entities survive when
  // another document still mentions them.
  await c.query(
    "DELETE FROM retrieval_documents WHERE collection_id = $1 AND source = $2 AND external_id = $3",
    [input.collectionId, input.source, input.externalId],
  );
  await c.query(
    `INSERT INTO retrieval_documents
       (id, collection_id, source, external_id, locator, title, content_hash, access_scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])`,
    [
      documentId,
      input.collectionId,
      input.source,
      input.externalId,
      input.locator ?? null,
      input.title ?? null,
      contentHash(input.content),
      accessScopes,
    ],
  );

  const chunkIds: string[] = [];
  for (let chunkIndex = 0; chunkIndex < input.chunks.length; chunkIndex++) {
    const chunk = input.chunks[chunkIndex];
    const text = chunk.text.trim();
    if (!text) throw new Error(`Retrieval chunk ${chunkIndex} is blank`);
    const chunkId = stableId("rtchunk", `${documentId}\n${chunkIndex}`);
    chunkIds.push(chunkId);
    await c.query(
      `INSERT INTO retrieval_chunks
         (id, collection_id, document_id, chunk_index, text, breadcrumb, content_hash, access_scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])`,
      [
        chunkId,
        input.collectionId,
        documentId,
        chunkIndex,
        text,
        chunk.breadcrumb ?? null,
        digest(text),
        accessScopes,
      ],
    );
  }

  const entityIdByKey = new Map<string, string>();
  const entityIds = new Set<string>();
  for (const entity of input.extraction.entities) {
    if (entityIdByKey.has(entity.key))
      throw new Error(`Duplicate extraction entity key: ${entity.key}`);
    const normalizedNames = uniqueStrings([entity.name, ...(entity.aliases ?? [])])
      .map(normalizeRetrievalEntityName)
      .filter(Boolean);
    const normalizedName = canonicalNormalizedName(entity);
    const existing = (
      await c.query<{
        id: string;
        name: string;
        aliases: string[];
        normalized_aliases: string[];
        description: string | null;
      }>(
        `SELECT id, name, aliases, normalized_aliases, description
           FROM retrieval_entities
          WHERE collection_id = $1 AND entity_type = $2
            AND (normalized_name = ANY($3::text[]) OR normalized_aliases && $3::text[])
          ORDER BY (normalized_name = $4) DESC, id
          LIMIT 1`,
        [input.collectionId, entity.type, normalizedNames, normalizedName],
      )
    ).rows[0];
    const entityId =
      existing?.id ??
      stableId("rtentity", `${input.collectionId}\n${entity.type}\n${normalizedName}`);
    const aliases = uniqueStrings([
      ...(existing?.aliases ?? []),
      ...(existing && existing.name !== entity.name ? [entity.name] : []),
      ...(entity.aliases ?? []),
    ]);
    const normalizedAliases = uniqueStrings([
      ...(existing?.normalized_aliases ?? []),
      ...normalizedNames,
    ]);
    await c.query(
      `INSERT INTO retrieval_entities
         (id, collection_id, entity_type, name, normalized_name, aliases, normalized_aliases, description)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8)
       ON CONFLICT (id) DO UPDATE SET
         aliases = EXCLUDED.aliases,
         normalized_aliases = EXCLUDED.normalized_aliases,
         description = coalesce(EXCLUDED.description, retrieval_entities.description)`,
      [
        entityId,
        input.collectionId,
        entity.type,
        existing?.name ?? entity.name,
        existing ? normalizeRetrievalEntityName(existing.name) : normalizedName,
        aliases,
        normalizedAliases,
        entity.description ?? existing?.description ?? null,
      ],
    );
    entityIdByKey.set(entity.key, entityId);
    entityIds.add(entityId);

    for (const mention of entity.mentions) {
      const chunkId = chunkIds[mention.chunkIndex];
      if (!chunkId) {
        throw new Error(`Entity ${entity.key} references missing chunk ${mention.chunkIndex}`);
      }
      await c.query(
        `INSERT INTO retrieval_mentions
           (collection_id, entity_id, chunk_id, start_offset, end_offset, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (entity_id, chunk_id, start_offset) DO UPDATE SET
           end_offset = EXCLUDED.end_offset,
           confidence = EXCLUDED.confidence`,
        [
          input.collectionId,
          entityId,
          chunkId,
          mention.startOffset ?? -1,
          mention.endOffset ?? null,
          mention.confidence ?? 1,
        ],
      );
    }
  }

  const relationIds: string[] = [];
  for (const relation of input.extraction.relationships) {
    const fromEntityId = entityIdByKey.get(relation.fromKey);
    const toEntityId = entityIdByKey.get(relation.toKey);
    const sourceChunkId = chunkIds[relation.chunkIndex];
    if (!fromEntityId || !toEntityId) {
      throw new Error(`Relationship ${relation.type} references an unknown entity key`);
    }
    if (!sourceChunkId) {
      throw new Error(
        `Relationship ${relation.type} references missing chunk ${relation.chunkIndex}`,
      );
    }
    const relationId = stableId(
      "rtrelation",
      `${sourceChunkId}\n${fromEntityId}\n${relation.type}\n${toEntityId}\n${relation.fact}`,
    );
    relationIds.push(relationId);
    await c.query(
      `INSERT INTO retrieval_relations
         (id, collection_id, from_entity_id, to_entity_id, relation_type, fact,
          source_chunk_id, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET confidence = EXCLUDED.confidence`,
      [
        relationId,
        input.collectionId,
        fromEntityId,
        toEntityId,
        relation.type,
        relation.fact,
        sourceChunkId,
        relation.confidence ?? 1,
      ],
    );
  }

  // Remove exact-resolution entities whose last supporting document was just
  // replaced and did not recreate them.
  await c.query(
    `DELETE FROM retrieval_entities e
      WHERE e.collection_id = $1
        AND NOT EXISTS (SELECT 1 FROM retrieval_mentions m WHERE m.entity_id = e.id)
        AND NOT EXISTS (
          SELECT 1 FROM retrieval_relations r
           WHERE r.from_entity_id = e.id OR r.to_entity_id = e.id
        )`,
    [input.collectionId],
  );

  let embeddings: EmbeddingsReport | undefined;
  if (opts.embeddingProvider) {
    const entityRows = (
      await c.query<{
        id: string;
        name: string;
        aliases: string[];
        description: string | null;
      }>(
        `SELECT id, name, aliases, description FROM retrieval_entities
          WHERE collection_id = $1 AND id = ANY($2::text[])`,
        [input.collectionId, [...entityIds]],
      )
    ).rows;
    const reports = await Promise.all([
      upsertEmbeddings(
        c,
        input.chunks.map((chunk, index) => ({
          collection_id: input.collectionId,
          source: "retrieval_chunk" as const,
          entity_id: chunkIds[index],
          chunks: [[chunk.breadcrumb, chunk.text].filter(Boolean).join("\n")],
        })),
        opts.embeddingProvider,
      ),
      upsertEmbeddings(
        c,
        entityRows.map((entity) => ({
          collection_id: input.collectionId,
          source: "retrieval_entity" as const,
          entity_id: entity.id,
          chunks: [[entity.name, ...entity.aliases, entity.description].filter(Boolean).join("\n")],
        })),
        opts.embeddingProvider,
      ),
      upsertEmbeddings(
        c,
        input.extraction.relationships.map((relation, index) => ({
          collection_id: input.collectionId,
          source: "retrieval_relation" as const,
          entity_id: relationIds[index],
          chunks: [relation.fact],
        })),
        opts.embeddingProvider,
      ),
    ]);
    embeddings = {
      computed: reports.reduce((sum, report) => sum + report.computed, 0),
      skipped: reports.reduce((sum, report) => sum + report.skipped, 0),
      pruned: reports.reduce((sum, report) => sum + report.pruned, 0),
      modelId: opts.embeddingProvider.modelId,
    };
  }

  return {
    documentId,
    chunkIds,
    entityIds: [...entityIds],
    relationIds,
    ...(embeddings ? { embeddings } : {}),
  };
}

const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "do",
  "does",
  "for",
  "how",
  "in",
  "is",
  "of",
  "the",
  "to",
  "what",
  "where",
  "which",
  "who",
  "why",
]);

function keywordValues(queryText: string, keywords: string[]): string[] {
  if (keywords.length > 0) return uniqueStrings(keywords);
  return uniqueStrings(
    queryText
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.filter((value) => value.length > 1 && !QUERY_STOP_WORDS.has(value)) ?? [],
  );
}

function keywordQuery(queryText: string, keywords: string[]): string {
  const values = keywordValues(queryText, keywords);
  if (values.length === 0) return `"${queryText.replaceAll('"', " ")}"`;
  return values.map((value) => `"${value.replaceAll('"', " ")}"`).join(" OR ");
}

export async function searchRetrievalChunksFts(
  c: QueryClient,
  args: {
    collectionId: string;
    queryText: string;
    keywords?: string[];
    accessScopes: string[];
    limit: number;
  },
): Promise<Array<RetrievalChunkRow & { rank: number }>> {
  const rows = (
    await c.query<RetrievalChunkRow & { rank: number | string }>(
      `WITH query AS (SELECT websearch_to_tsquery('english', $2) AS q)
       SELECT ch.id, ch.document_id, d.source, d.external_id, d.locator, d.title,
              ch.chunk_index, ch.text, ch.breadcrumb,
              ts_rank_cd(ch.search_tsv, query.q) AS rank
         FROM retrieval_chunks ch
         JOIN retrieval_documents d ON d.id = ch.document_id
         CROSS JOIN query
        WHERE ch.collection_id = $1
          AND ch.access_scopes && $3::text[]
          AND ch.search_tsv @@ query.q
        ORDER BY rank DESC, ch.id
        LIMIT $4`,
      [
        args.collectionId,
        keywordQuery(args.queryText, args.keywords ?? []),
        args.accessScopes,
        args.limit,
      ],
    )
  ).rows;
  return rows.map((row) => ({ ...row, rank: Number(row.rank) }));
}

export async function searchRetrievalEntitiesFts(
  c: QueryClient,
  args: {
    collectionId: string;
    queryText: string;
    keywords?: string[];
    accessScopes: string[];
    limit: number;
  },
): Promise<RetrievalEntityHit[]> {
  const normalizedTerms = uniqueStrings(
    keywordValues(args.queryText, args.keywords ?? []).map(normalizeRetrievalEntityName),
  );
  const rows = (
    await c.query<Omit<RetrievalEntityHit, "rank"> & { rank: number | string }>(
      `WITH query AS (SELECT websearch_to_tsquery('english', $2) AS q)
       SELECT e.id, e.name, e.entity_type,
              (strpos(' ' || $6 || ' ', ' ' || e.normalized_name || ' ') > 0
               OR EXISTS (
                 SELECT 1 FROM unnest(e.normalized_aliases) AS alias
                  WHERE strpos(' ' || $6 || ' ', ' ' || alias || ' ') > 0
               )) AS exact,
              CASE WHEN e.normalized_name = ANY($5::text[])
                         OR e.normalized_aliases && $5::text[]
                   THEN 1 ELSE ts_rank_cd(e.search_tsv, query.q) END AS rank
         FROM retrieval_entities e CROSS JOIN query
        WHERE e.collection_id = $1
          AND (e.search_tsv @@ query.q
               OR e.normalized_name = ANY($5::text[])
               OR e.normalized_aliases && $5::text[])
          AND EXISTS (
            SELECT 1 FROM retrieval_mentions m
            JOIN retrieval_chunks ch ON ch.id = m.chunk_id
             WHERE m.entity_id = e.id AND ch.access_scopes && $3::text[]
          )
        ORDER BY exact DESC, rank DESC, e.id
        LIMIT $4`,
      [
        args.collectionId,
        keywordQuery(args.queryText, args.keywords ?? []),
        args.accessScopes,
        args.limit,
        normalizedTerms,
        normalizeRetrievalEntityName(args.queryText),
      ],
    )
  ).rows;
  return rows.map((row) => ({ ...row, exact: Boolean(row.exact), rank: Number(row.rank) }));
}

export async function searchRetrievalRelationsFts(
  c: QueryClient,
  args: {
    collectionId: string;
    queryText: string;
    keywords?: string[];
    accessScopes: string[];
    limit: number;
    minimumConfidence?: number;
  },
): Promise<Array<RetrievalRelationRow & { rank: number }>> {
  const rows = (
    await c.query<RetrievalRelationRow & { rank: number | string }>(
      `WITH query AS (SELECT websearch_to_tsquery('english', $2) AS q)
       SELECT r.id, r.from_entity_id, r.to_entity_id, r.relation_type, r.fact,
              r.source_chunk_id, r.confidence,
              ts_rank_cd(r.search_tsv, query.q) AS rank
         FROM retrieval_relations r
         JOIN retrieval_chunks ch ON ch.id = r.source_chunk_id
         CROSS JOIN query
        WHERE r.collection_id = $1
          AND ch.access_scopes && $3::text[]
          AND r.confidence >= $5
          AND r.search_tsv @@ query.q
        ORDER BY rank DESC, r.id
        LIMIT $4`,
      [
        args.collectionId,
        keywordQuery(args.queryText, args.keywords ?? []),
        args.accessScopes,
        args.limit,
        args.minimumConfidence ?? 0,
      ],
    )
  ).rows;
  return rows.map((row) => ({
    ...row,
    confidence: Number(row.confidence),
    rank: Number(row.rank),
  }));
}

export async function listAccessibleRetrievalIds(
  c: QueryClient,
  args: {
    collectionId: string;
    kind: "chunk" | "entity" | "relation";
    accessScopes: string[];
  },
): Promise<string[]> {
  const sql =
    args.kind === "chunk"
      ? `SELECT id FROM retrieval_chunks
          WHERE collection_id = $1 AND access_scopes && $2::text[]`
      : args.kind === "entity"
        ? `SELECT e.id FROM retrieval_entities e
            WHERE e.collection_id = $1 AND EXISTS (
              SELECT 1 FROM retrieval_mentions m
              JOIN retrieval_chunks ch ON ch.id = m.chunk_id
               WHERE m.entity_id = e.id AND ch.access_scopes && $2::text[]
            )`
        : `SELECT r.id FROM retrieval_relations r
            JOIN retrieval_chunks ch ON ch.id = r.source_chunk_id
           WHERE r.collection_id = $1 AND ch.access_scopes && $2::text[]`;
  return (await c.query<{ id: string }>(sql, [args.collectionId, args.accessScopes])).rows.map(
    (row) => row.id,
  );
}

export async function rankRetrievalVectors(
  c: QueryClient,
  args: {
    collectionId: string;
    kind: "chunk" | "entity" | "relation";
    semantic: SemanticQuery;
    accessScopes: string[];
    limit: number;
    ids?: string[];
  },
) {
  const accessible = await listAccessibleRetrievalIds(c, {
    collectionId: args.collectionId,
    kind: args.kind,
    accessScopes: args.accessScopes,
  });
  const accessibleSet = new Set(accessible);
  const permitted = args.ids ? args.ids.filter((id) => accessibleSet.has(id)) : accessible;
  return rankEmbeddings(c, {
    collectionIds: [args.collectionId],
    source: `retrieval_${args.kind}`,
    modelId: args.semantic.modelId,
    queryEmbedding: args.semantic.queryEmbedding,
    limit: args.limit,
    entityIds: permitted,
  });
}

export async function loadRetrievalRelations(
  c: QueryClient,
  args: {
    collectionId: string;
    ids: string[];
    accessScopes: string[];
  },
): Promise<RetrievalRelationRow[]> {
  if (args.ids.length === 0) return [];
  const rows = (
    await c.query<RetrievalRelationRow & { confidence: number | string }>(
      `SELECT r.id, r.from_entity_id, r.to_entity_id, r.relation_type, r.fact,
              r.source_chunk_id, r.confidence
         FROM retrieval_relations r
         JOIN retrieval_chunks ch ON ch.id = r.source_chunk_id
        WHERE r.collection_id = $1 AND r.id = ANY($2::text[])
          AND ch.access_scopes && $3::text[]`,
      [args.collectionId, args.ids, args.accessScopes],
    )
  ).rows;
  return rows.map((row) => ({ ...row, confidence: Number(row.confidence) }));
}

export async function expandRetrievalRelations(
  c: QueryClient,
  args: {
    collectionId: string;
    seedEntityIds: string[];
    accessScopes: string[];
    maxHops?: number;
    limit: number;
    minimumConfidence?: number;
  },
): Promise<RetrievalRelationExpansion[]> {
  const seenRelations = new Set<string>();
  const seenEntities = new Set(args.seedEntityIds);
  let frontier = [...args.seedEntityIds];
  const expanded: RetrievalRelationExpansion[] = [];
  for (let hop = 1; hop <= (args.maxHops ?? 2) && frontier.length > 0; hop++) {
    const remaining = args.limit - expanded.length;
    if (remaining <= 0) break;
    const rows = (
      await c.query<RetrievalRelationRow & { confidence: number | string }>(
        `SELECT r.id, r.from_entity_id, r.to_entity_id, r.relation_type, r.fact,
                r.source_chunk_id, r.confidence
           FROM retrieval_relations r
           JOIN retrieval_chunks ch ON ch.id = r.source_chunk_id
          WHERE r.collection_id = $1
            AND (r.from_entity_id = ANY($2::text[]) OR r.to_entity_id = ANY($2::text[]))
            AND ch.access_scopes && $3::text[]
            AND r.confidence >= $5
          ORDER BY r.confidence DESC, r.id
          LIMIT $4`,
        [args.collectionId, frontier, args.accessScopes, remaining, args.minimumConfidence ?? 0],
      )
    ).rows;
    const next = new Set<string>();
    for (const row of rows) {
      if (!seenRelations.has(row.id)) {
        seenRelations.add(row.id);
        expanded.push({ ...row, confidence: Number(row.confidence), hop });
      }
      for (const entityId of [row.from_entity_id, row.to_entity_id]) {
        if (!seenEntities.has(entityId)) {
          seenEntities.add(entityId);
          next.add(entityId);
        }
      }
    }
    frontier = [...next];
  }
  return expanded;
}

export async function loadChunksMentioningEntities(
  c: QueryClient,
  args: {
    collectionId: string;
    entityIds: string[];
    accessScopes: string[];
    limit: number;
  },
): Promise<Array<RetrievalChunkRow & { entity_id: string }>> {
  if (args.entityIds.length === 0) return [];
  return (
    await c.query<RetrievalChunkRow & { entity_id: string }>(
      `SELECT ch.id, ch.document_id, d.source, d.external_id, d.locator, d.title,
              ch.chunk_index, ch.text, ch.breadcrumb, m.entity_id
         FROM retrieval_mentions m
         JOIN retrieval_chunks ch ON ch.id = m.chunk_id
         JOIN retrieval_documents d ON d.id = ch.document_id
        WHERE m.collection_id = $1 AND m.entity_id = ANY($2::text[])
          AND ch.access_scopes && $3::text[]
        ORDER BY m.confidence DESC, ch.id
        LIMIT $4`,
      [args.collectionId, args.entityIds, args.accessScopes, args.limit],
    )
  ).rows;
}

export async function loadRetrievalChunks(
  c: QueryClient,
  args: {
    collectionId: string;
    ids: string[];
    accessScopes: string[];
  },
): Promise<RetrievalChunkRow[]> {
  if (args.ids.length === 0) return [];
  return (
    await c.query<RetrievalChunkRow>(
      `SELECT ch.id, ch.document_id, d.source, d.external_id, d.locator, d.title,
              ch.chunk_index, ch.text, ch.breadcrumb
         FROM retrieval_chunks ch
         JOIN retrieval_documents d ON d.id = ch.document_id
        WHERE ch.collection_id = $1 AND ch.id = ANY($2::text[])
          AND ch.access_scopes && $3::text[]`,
      [args.collectionId, args.ids, args.accessScopes],
    )
  ).rows;
}

export async function loadRetrievalChunkContext(
  c: QueryClient,
  args: { collectionId: string; chunkIds: string[] },
): Promise<{
  entityNamesByChunk: Map<string, string[]>;
  relationsByChunk: Map<string, RetrievalRelationRow[]>;
}> {
  const entityNamesByChunk = new Map<string, string[]>();
  const relationsByChunk = new Map<string, RetrievalRelationRow[]>();
  if (args.chunkIds.length === 0) return { entityNamesByChunk, relationsByChunk };
  const mentions = (
    await c.query<{ chunk_id: string; name: string }>(
      `SELECT m.chunk_id, e.name FROM retrieval_mentions m
       JOIN retrieval_entities e ON e.id = m.entity_id
       WHERE m.collection_id = $1 AND m.chunk_id = ANY($2::text[])
       ORDER BY m.chunk_id, e.name`,
      [args.collectionId, args.chunkIds],
    )
  ).rows;
  for (const mention of mentions) {
    const names = entityNamesByChunk.get(mention.chunk_id) ?? [];
    names.push(mention.name);
    entityNamesByChunk.set(mention.chunk_id, names);
  }
  const relations = (
    await c.query<RetrievalRelationRow & { confidence: number | string }>(
      `SELECT id, from_entity_id, to_entity_id, relation_type, fact,
              source_chunk_id, confidence
         FROM retrieval_relations
        WHERE collection_id = $1 AND source_chunk_id = ANY($2::text[])
        ORDER BY source_chunk_id, confidence DESC`,
      [args.collectionId, args.chunkIds],
    )
  ).rows;
  for (const relation of relations) {
    const rows = relationsByChunk.get(relation.source_chunk_id) ?? [];
    rows.push({ ...relation, confidence: Number(relation.confidence) });
    relationsByChunk.set(relation.source_chunk_id, rows);
  }
  return { entityNamesByChunk, relationsByChunk };
}
