// Falkor-style multi-path retrieval over Braino's rebuildable retrieval graph.
// Candidate discovery spans lexical chunks/entities/facts, vector chunks/facts,
// and entity mentions. Weighted reciprocal-rank fusion combines independent
// paths while a vector-dominant rerank and protected direct head prevent graph
// expansion from displacing the strongest direct evidence.

import {
  type QueryClient,
  type RetrievalChunkRow,
  type RetrievalRelationRow,
  type SemanticQuery,
  expandRetrievalRelations,
  loadChunksMentioningEntities,
  loadRetrievalChunkContext,
  loadRetrievalChunks,
  loadRetrievalRelations,
  rankRetrievalVectors,
  searchRetrievalChunksFts,
  searchRetrievalEntitiesFts,
  searchRetrievalRelationsFts,
} from "@doco/db";

export type RetrievalPath =
  | "chunk_lexical"
  | "chunk_vector"
  | "relationship_lexical"
  | "relationship_vector"
  | "entity_mention"
  | "neighbor_mention"
  | "graph_relation";

export interface MultiPathRetrievalItem {
  id: string;
  documentId: string;
  source: string;
  externalId: string;
  locator: string | null;
  title: string | null;
  text: string;
  breadcrumb: string | null;
  score: number | null;
  paths: RetrievalPath[];
  entities: string[];
  relationships: RetrievalRelationRow[];
}

export interface MultiPathRetrievalResult {
  items: MultiPathRetrievalItem[];
  stats: {
    entitySeeds: number;
    relationshipsExpanded: number;
    chunkCandidates: number;
    durationMs: number;
    usedVector: boolean;
  };
}

export interface MultiPathRetrievalInput {
  collectionId: string;
  queryText: string;
  /** A small query model may supply these; deterministic callers can pass
   * exact phrases. Without them the original query is used. */
  keywords?: string[];
  semantic: SemanticQuery | null;
  accessScopes: string[];
  limit?: number;
  chunkCandidateLimit?: number;
  maxEntities?: number;
  maxRelationships?: number;
  relationshipVectorLimit?: number;
  maxHops?: number;
  minimumRelationshipConfidence?: number;
}

function pushPath(
  pathsByChunk: Map<string, Set<RetrievalPath>>,
  chunkId: string,
  path: RetrievalPath,
): void {
  const paths = pathsByChunk.get(chunkId) ?? new Set<RetrievalPath>();
  paths.add(path);
  pathsByChunk.set(chunkId, paths);
}

function entityEndpoints(relations: RetrievalRelationRow[]): string[] {
  const ids = new Set<string>();
  for (const relation of relations) {
    ids.add(relation.from_entity_id);
    ids.add(relation.to_entity_id);
  }
  return [...ids];
}

const PATH_WEIGHTS: Record<RetrievalPath, number> = {
  chunk_lexical: 1,
  chunk_vector: 1,
  relationship_lexical: 0.6,
  relationship_vector: 0.6,
  entity_mention: 0.75,
  // These paths exist only after a high-confidence relationship was traversed.
  // Give the evidence bundle enough weight to enter the result window while
  // protectRankedHead still preserves the three strongest direct documents.
  neighbor_mention: 1.5,
  graph_relation: 1,
};

/** Weighted reciprocal-rank fusion makes ranks from independent retrieval
 * paths comparable without pretending their raw scores share a scale. */
export function fuseCandidateRanks(
  rankedIdsByPath: Partial<Record<RetrievalPath, string[]>>,
  rankConstant = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const [path, ids] of Object.entries(rankedIdsByPath) as Array<
    [RetrievalPath, string[] | undefined]
  >) {
    if (!ids) continue;
    const seen = new Set<string>();
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      if (seen.has(id)) continue;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + PATH_WEIGHTS[path] / (rankConstant + index + 1));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function protectRankedHead(
  directRankedIds: string[],
  allRankedIds: string[],
  protectedCount: number,
): string[] {
  const head = directRankedIds.slice(0, protectedCount);
  const protectedIds = new Set(head);
  return [...head, ...allRankedIds.filter((id) => !protectedIds.has(id))];
}

/**
 * Retrieve source chunks through Falkor's core paths:
 *
 * 1. lexical and vector chunk search;
 * 2. lexical entity discovery plus lexical/vector relationship facts;
 * 3. bounded one/two-hop relationship expansion;
 * 4. entity -> mention -> chunk and neighbour -> mention -> chunk;
 * 5. vector-dominant fusion over the union, preserving three direct documents.
 *
 * Access scopes constrain every discovery and traversal query, not merely the
 * final result list.
 */
export async function multiPathRetrieve(
  c: QueryClient,
  input: MultiPathRetrievalInput,
): Promise<MultiPathRetrievalResult> {
  const startedAt = performance.now();
  const limit = input.limit ?? 15;
  const candidateLimit = input.chunkCandidateLimit ?? 100;
  const maxEntities = input.maxEntities ?? 30;
  const maxRelationships = input.maxRelationships ?? 20;
  const relationshipVectorLimit = input.relationshipVectorLimit ?? 15;
  const minimumRelationshipConfidence = input.minimumRelationshipConfidence ?? 0.8;
  const keywords = input.keywords ?? [];

  // QueryClient is deliberately a single transaction/client boundary. The
  // node-postgres client serializes overlapping calls today but deprecates
  // them for pg 9, so keep reads explicit and sequential here. Callers that
  // want parallel I/O can provide separate clients above this boundary.
  const chunkLexical = await searchRetrievalChunksFts(c, {
    collectionId: input.collectionId,
    queryText: input.queryText,
    keywords,
    accessScopes: input.accessScopes,
    limit: candidateLimit,
  });
  const entityLexical = await searchRetrievalEntitiesFts(c, {
    collectionId: input.collectionId,
    queryText: input.queryText,
    keywords,
    accessScopes: input.accessScopes,
    limit: maxEntities,
  });
  const relationLexical = await searchRetrievalRelationsFts(c, {
    collectionId: input.collectionId,
    queryText: input.queryText,
    keywords,
    accessScopes: input.accessScopes,
    limit: relationshipVectorLimit,
    minimumConfidence: minimumRelationshipConfidence,
  });
  const chunkVector = input.semantic
    ? await rankRetrievalVectors(c, {
        collectionId: input.collectionId,
        kind: "chunk",
        semantic: input.semantic,
        accessScopes: input.accessScopes,
        limit: candidateLimit,
      })
    : [];
  const relationVector = input.semantic
    ? await rankRetrievalVectors(c, {
        collectionId: input.collectionId,
        kind: "relation",
        semantic: input.semantic,
        accessScopes: input.accessScopes,
        limit: relationshipVectorLimit,
      })
    : [];

  const vectorRelations = await loadRetrievalRelations(c, {
    collectionId: input.collectionId,
    ids: relationVector.map((hit) => hit.entity_id),
    accessScopes: input.accessScopes,
  });
  const acceptedVectorRelations = vectorRelations.filter(
    (relation) => relation.confidence >= minimumRelationshipConfidence,
  );
  const discoveredRelations = new Map<string, RetrievalRelationRow>();
  for (const relation of [...relationLexical, ...acceptedVectorRelations]) {
    discoveredRelations.set(relation.id, relation);
  }

  const directEntityIds = entityLexical.filter((entity) => entity.exact).map((entity) => entity.id);
  const seedEntityIds = directEntityIds.slice(0, maxEntities);
  const expandedRelations = await expandRetrievalRelations(c, {
    collectionId: input.collectionId,
    seedEntityIds,
    accessScopes: input.accessScopes,
    maxHops: input.maxHops ?? 1,
    limit: maxRelationships,
    minimumConfidence: minimumRelationshipConfidence,
  });
  const expandedEntityIds = entityEndpoints(expandedRelations);
  const directEntitySet = new Set(directEntityIds);
  const neighbourEntityIds = expandedEntityIds.filter((id) => !directEntitySet.has(id));
  const directMentions = await loadChunksMentioningEntities(c, {
    collectionId: input.collectionId,
    entityIds: directEntityIds,
    accessScopes: input.accessScopes,
    limit: candidateLimit,
  });
  const neighbourMentions = await loadChunksMentioningEntities(c, {
    collectionId: input.collectionId,
    entityIds: neighbourEntityIds,
    accessScopes: input.accessScopes,
    limit: candidateLimit,
  });

  const pathsByChunk = new Map<string, Set<RetrievalPath>>();
  for (const chunk of chunkLexical) pushPath(pathsByChunk, chunk.id, "chunk_lexical");
  for (const hit of chunkVector) pushPath(pathsByChunk, hit.entity_id, "chunk_vector");
  for (const relation of relationLexical) {
    pushPath(pathsByChunk, relation.source_chunk_id, "relationship_lexical");
  }
  for (const relation of acceptedVectorRelations) {
    pushPath(pathsByChunk, relation.source_chunk_id, "relationship_vector");
  }
  for (const relation of expandedRelations) {
    pushPath(pathsByChunk, relation.source_chunk_id, "graph_relation");
  }
  for (const chunk of directMentions) pushPath(pathsByChunk, chunk.id, "entity_mention");
  for (const chunk of neighbourMentions) pushPath(pathsByChunk, chunk.id, "neighbor_mention");

  const directFusion = fuseCandidateRanks({
    chunk_lexical: chunkLexical.map((chunk) => chunk.id),
    chunk_vector: chunkVector.map((hit) => hit.entity_id),
  });
  const graphFusion = fuseCandidateRanks({
    relationship_lexical: relationLexical.map((relation) => relation.source_chunk_id),
    relationship_vector: acceptedVectorRelations.map((relation) => relation.source_chunk_id),
    entity_mention: directMentions.map((chunk) => chunk.id),
    neighbor_mention: neighbourMentions.map((chunk) => chunk.id),
    graph_relation: expandedRelations.map((relation) => relation.source_chunk_id),
  });
  const candidateFusion = fuseCandidateRanks({
    chunk_lexical: chunkLexical.map((chunk) => chunk.id),
    chunk_vector: chunkVector.map((hit) => hit.entity_id),
    relationship_lexical: relationLexical.map((relation) => relation.source_chunk_id),
    relationship_vector: acceptedVectorRelations.map((relation) => relation.source_chunk_id),
    entity_mention: directMentions.map((chunk) => chunk.id),
    neighbor_mention: neighbourMentions.map((chunk) => chunk.id),
    graph_relation: expandedRelations.map((relation) => relation.source_chunk_id),
  });
  const candidateIds = [
    ...new Set([
      ...directFusion.slice(0, candidateLimit).map((candidate) => candidate.id),
      ...graphFusion.slice(0, Math.min(100, maxRelationships * 5)).map((candidate) => candidate.id),
    ]),
  ];
  let rankedIds = candidateIds;
  const scoreById = new Map<string, number>();
  if (input.semantic && candidateIds.length > 0) {
    const vectorRanked = await rankRetrievalVectors(c, {
      collectionId: input.collectionId,
      kind: "chunk",
      semantic: input.semantic,
      accessScopes: input.accessScopes,
      ids: candidateIds,
      limit: candidateIds.length,
    });
    const vectorRankById = new Map(
      vectorRanked.map((hit, index) => [hit.entity_id, { rank: index + 1, score: hit.score }]),
    );
    const fusionById = new Map(candidateFusion.map((candidate) => [candidate.id, candidate.score]));
    const directFusionById = new Map(
      directFusion.map((candidate) => [candidate.id, candidate.score]),
    );
    rankedIds = [...candidateIds].sort((left, right) => {
      const leftVector = vectorRankById.get(left);
      const rightVector = vectorRankById.get(right);
      const leftScore = (leftVector ? 4 / (60 + leftVector.rank) : 0) + (fusionById.get(left) ?? 0);
      const rightScore =
        (rightVector ? 4 / (60 + rightVector.rank) : 0) + (fusionById.get(right) ?? 0);
      return rightScore - leftScore || left.localeCompare(right);
    });
    const directRankedIds = directFusion
      .slice(0, candidateLimit)
      .map((candidate) => candidate.id)
      .sort((left, right) => {
        const leftVector = vectorRankById.get(left);
        const rightVector = vectorRankById.get(right);
        const leftScore =
          (leftVector ? 4 / (60 + leftVector.rank) : 0) + (directFusionById.get(left) ?? 0);
        const rightScore =
          (rightVector ? 4 / (60 + rightVector.rank) : 0) + (directFusionById.get(right) ?? 0);
        return rightScore - leftScore || left.localeCompare(right);
      });
    if (graphFusion.length > 0) {
      const candidateChunks = await loadRetrievalChunks(c, {
        collectionId: input.collectionId,
        ids: candidateIds,
        accessScopes: input.accessScopes,
      });
      const documentByChunk = new Map(
        candidateChunks.map((chunk) => [chunk.id, chunk.document_id]),
      );
      const protectedDocuments = new Set<string>();
      const protectedIds: string[] = [];
      for (const id of directRankedIds) {
        const documentId = documentByChunk.get(id);
        if (!documentId || protectedDocuments.has(documentId)) continue;
        protectedDocuments.add(documentId);
        protectedIds.push(id);
        if (protectedDocuments.size === 3) break;
      }
      rankedIds = protectRankedHead(protectedIds, rankedIds, protectedIds.length);
    }
    for (const id of rankedIds) {
      const vector = vectorRankById.get(id);
      const score = (vector ? 4 / (60 + vector.rank) : 0) + (fusionById.get(id) ?? 0);
      scoreById.set(id, score);
    }
  } else {
    for (const candidate of candidateFusion) scoreById.set(candidate.id, candidate.score);
  }

  const finalIds = rankedIds.slice(0, limit);
  const chunks = await loadRetrievalChunks(c, {
    collectionId: input.collectionId,
    ids: finalIds,
    accessScopes: input.accessScopes,
  });
  const context = await loadRetrievalChunkContext(c, {
    collectionId: input.collectionId,
    chunkIds: finalIds,
  });
  const chunkById = new Map<string, RetrievalChunkRow>(chunks.map((chunk) => [chunk.id, chunk]));
  const items = finalIds.flatMap((id): MultiPathRetrievalItem[] => {
    const chunk = chunkById.get(id);
    if (!chunk) return [];
    return [
      {
        id: chunk.id,
        documentId: chunk.document_id,
        source: chunk.source,
        externalId: chunk.external_id,
        locator: chunk.locator,
        title: chunk.title,
        text: chunk.text,
        breadcrumb: chunk.breadcrumb,
        score: scoreById.get(id) ?? null,
        paths: [...(pathsByChunk.get(id) ?? [])],
        entities: context.entityNamesByChunk.get(id) ?? [],
        relationships: context.relationsByChunk.get(id) ?? [],
      },
    ];
  });

  return {
    items,
    stats: {
      entitySeeds: seedEntityIds.length,
      relationshipsExpanded: expandedRelations.length,
      chunkCandidates: candidateIds.length,
      durationMs: Math.round(performance.now() - startedAt),
      usedVector: input.semantic !== null,
    },
  };
}
