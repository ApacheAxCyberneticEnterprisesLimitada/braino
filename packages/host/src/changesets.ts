import {
  type CommitSource,
  EDGE_ENDPOINTS_NOT_ACTIVE,
  type PoolClient,
  appendAuditEventRow,
  appendNodeVersion,
  createChangeset,
  createEdge,
  nodeRowFromFields,
  upsertNode,
} from "@doco/db";
import {
  BLOCKED_NODE_JSON_EDGE_FIELD_SET,
  CAPTURE_SCHEMAS,
  type CandidateFields,
  type CatalogNodeType,
  type CatalogRelationKind,
  type EngineEdge,
  type Lifecycle,
  type LoadedPolicy,
  RELATION_CATALOG,
  type WritableType,
  canWriteType,
  evaluateEdgePolicies,
  evaluatePolicies,
  generateUlid,
  isDeterministicPredicate,
  normalizeWriteTypes,
} from "@doco/shared";

const LIFECYCLES = new Set(["drafting", "queued", "active", "retired"]);
const RESERVED_BODY_KEYS = new Set([
  "prose",
  "extra",
  "kind",
  "locator",
  "lifecycle",
  "created_by_user_id",
]);

type GenericNodeType = keyof typeof CAPTURE_SCHEMAS;

export interface CreateOperation {
  op: "create";
  node_type: GenericNodeType;
  alias?: string;
  body: Record<string, unknown>;
}

export interface ChangesetOperationResult {
  op_index: number;
  op: "create" | "relate" | "relate_many";
  ok: true;
  id?: string;
  alias?: string;
  relation?: RelationResult;
  relations?: RelationResult[];
  warnings?: { policy_id: string; reason: string }[];
}

export interface RelationResult {
  kind: CatalogRelationKind;
  from: string;
  to: string;
  edge_id: string;
}

export interface ApplyChangesetResult {
  ok: true;
  results: ChangesetOperationResult[];
  aliases: Record<string, string>;
}

export interface ApplyChangesetInput {
  collectionHandle: string;
  actorId: string;
  operations: unknown;
  source?: CommitSource;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export class ChangesetError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
    public readonly operationIndex?: number,
  ) {
    super(message);
    this.name = "ChangesetError";
  }
}

interface CollectionAccess {
  id: string;
  workspace_id: string;
  default_node_lifecycle: string | null;
  collection_role: string | null;
  collection_write_types: string[] | null;
  workspace_role: string | null;
  workspace_write_types: string[] | null;
}

interface PreparedCreate {
  op: "create";
  nodeType: GenericNodeType;
  alias?: string;
  fields: Record<string, unknown>;
}

interface PreparedRelation {
  kind: CatalogRelationKind;
  from: string;
  to: string;
  lifecycle?: "drafting" | "queued" | "active";
  label: string | null;
  condition: string | null;
  kindMetadata: string | null;
}

interface PreparedRelate extends PreparedRelation {
  op: "relate";
}

interface PreparedRelateMany {
  op: "relate_many";
  relations: PreparedRelation[];
}

type PreparedOperation = PreparedCreate | PreparedRelate | PreparedRelateMany;

const RETIRED_POLICY_KINDS = new Set([
  "requires_entity_type",
  "requires_node_type",
  "forbids_edge",
  "forbids_field",
]);

function role(value: string | null): "owner" | "writer" | "reader" | null {
  return value === "owner" || value === "writer" || value === "reader" ? value : null;
}

function grantAllows(rawRole: string | null, rawTypes: string[] | null, type: WritableType) {
  const grantRole = role(rawRole);
  const writeTypes = normalizeWriteTypes(rawTypes);
  if (grantRole === "writer" && writeTypes.length === 0) writeTypes.push("*");
  return canWriteType(grantRole, writeTypes, type);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date().toISOString();
}

function cleanAlias(value: unknown, index: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ChangesetError("create.alias must be a string.", "invalid_alias", 400, index);
  }
  const alias = value.trim().replace(/^\$/, "");
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(alias)) {
    throw new ChangesetError(
      "create.alias must start with a letter and contain only letters, numbers, hyphens, or underscores.",
      "invalid_alias",
      400,
      index,
    );
  }
  return alias;
}

function prepareOperation(
  raw: unknown,
  index: number,
  collection: CollectionAccess,
  actorId: string,
  aliases: Map<string, string>,
): PreparedOperation {
  if (!plainObject(raw)) {
    throw new ChangesetError(
      'Operation must be an object with op "create", "relate", or "relate_many".',
      "unsupported_operation",
      400,
      index,
    );
  }
  if (raw.op === "relate") {
    return { op: "relate", ...prepareRelation(raw, index, collection, aliases) };
  }
  if (raw.op === "relate_many") {
    if (!Array.isArray(raw.relations) || raw.relations.length === 0) {
      throw new ChangesetError(
        "relate_many.relations must be a non-empty array.",
        "invalid_relations",
        400,
        index,
      );
    }
    if (raw.relations.length > 50) {
      throw new ChangesetError(
        "relate_many accepts at most 50 relations.",
        "too_many_relations",
        400,
        index,
      );
    }
    return {
      op: "relate_many",
      relations: raw.relations.map((relation) =>
        prepareRelation(relation, index, collection, aliases),
      ),
    };
  }
  if (raw.op !== "create") {
    throw new ChangesetError(
      `Unsupported operation "${String(raw.op)}". This release supports create, relate, and relate_many operations.`,
      "unsupported_operation",
      400,
      index,
    );
  }
  const nodeTypeValue = typeof raw.node_type === "string" ? raw.node_type.trim().toLowerCase() : "";
  const schema = CAPTURE_SCHEMAS[nodeTypeValue as GenericNodeType];
  if (!schema) {
    throw new ChangesetError(
      `Unsupported create node_type "${String(raw.node_type)}".`,
      "unsupported_node_type",
      400,
      index,
    );
  }
  const nodeType = nodeTypeValue as GenericNodeType;
  if (
    !grantAllows(collection.collection_role, collection.collection_write_types, nodeType) &&
    !grantAllows(collection.workspace_role, collection.workspace_write_types, nodeType)
  ) {
    throw new ChangesetError(
      `You do not have permission to write ${nodeType} records in this collection.`,
      "write_forbidden",
      403,
      index,
    );
  }
  if (!plainObject(raw.body)) {
    throw new ChangesetError("create.body must be an object.", "invalid_body", 400, index);
  }
  const prose = typeof raw.body.prose === "string" ? raw.body.prose.trim() : "";
  if (!prose) {
    throw new ChangesetError("create.body.prose is required.", "prose_required", 400, index);
  }
  if (raw.body.extra !== undefined && !plainObject(raw.body.extra)) {
    throw new ChangesetError("create.body.extra must be an object.", "invalid_extra", 400, index);
  }
  const extra: Record<string, unknown> = {
    ...(raw.body.extra as Record<string, unknown> | undefined),
  };
  for (const [key, value] of Object.entries(raw.body)) {
    if (!RESERVED_BODY_KEYS.has(key)) extra[key] = value;
  }
  for (const key of [...Object.keys(raw.body), ...Object.keys(extra)]) {
    if (BLOCKED_NODE_JSON_EDGE_FIELD_SET.has(key)) {
      throw new ChangesetError(
        `${key} is not a node JSON field. Relationships must be authored as first-class edges.`,
        "edge_field_forbidden",
        400,
        index,
      );
    }
  }
  const requestedLifecycle = raw.body.lifecycle;
  if (requestedLifecycle !== undefined && !LIFECYCLES.has(String(requestedLifecycle))) {
    throw new ChangesetError(
      `Unknown lifecycle "${String(requestedLifecycle)}".`,
      "invalid_lifecycle",
      400,
      index,
    );
  }
  const lifecycle =
    (typeof requestedLifecycle === "string" && requestedLifecycle) ||
    collection.default_node_lifecycle ||
    schema.defaultLifecycle;
  const alias = cleanAlias(raw.alias, index);
  if (alias && aliases.has(alias)) {
    throw new ChangesetError(`Duplicate alias "${alias}".`, "duplicate_alias", 400, index);
  }
  const now = new Date().toISOString();
  const id = `${nodeType}_${generateUlid()}`;
  if (alias) aliases.set(alias, id);
  return {
    op: "create",
    nodeType,
    ...(alias ? { alias } : {}),
    fields: {
      ...extra,
      id,
      collection_id: collection.id,
      node_type: nodeType,
      prose,
      ...(typeof raw.body.kind === "string" ? { kind: raw.body.kind } : {}),
      ...(typeof raw.body.locator === "string" ? { locator: raw.body.locator } : {}),
      lifecycle,
      created_at: now,
      created_by: actorId,
      updated_at: now,
      updated_by: actorId,
    },
  };
}

function resolveReference(value: unknown, aliases: Map<string, string>, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChangesetError(
      "Relation endpoints must be node ids or $aliases.",
      "invalid_relation_endpoint",
      400,
      index,
    );
  }
  const reference = value.trim();
  if (!reference.startsWith("$")) return reference;
  const resolved = aliases.get(reference.slice(1));
  if (!resolved) {
    throw new ChangesetError(
      `Unknown or forward alias "${reference}".`,
      "unknown_alias",
      400,
      index,
    );
  }
  return resolved;
}

function prepareRelation(
  raw: unknown,
  index: number,
  collection: CollectionAccess,
  aliases: Map<string, string>,
): PreparedRelation {
  if (!plainObject(raw)) {
    throw new ChangesetError("Relation must be an object.", "invalid_relation", 400, index);
  }
  const kindValue =
    typeof raw.relation_kind === "string"
      ? raw.relation_kind.trim()
      : typeof raw.kind === "string"
        ? raw.kind.trim()
        : "";
  const spec = RELATION_CATALOG[kindValue as CatalogRelationKind];
  if (!spec) {
    throw new ChangesetError(
      `Unknown relation_kind "${kindValue}".`,
      "unknown_relation_kind",
      400,
      index,
    );
  }
  const kind = kindValue as CatalogRelationKind;
  if (
    !grantAllows(collection.collection_role, collection.collection_write_types, kind) &&
    !grantAllows(collection.workspace_role, collection.workspace_write_types, kind)
  ) {
    throw new ChangesetError(
      `You do not have permission to write ${kind} relations in this collection.`,
      "write_forbidden",
      403,
      index,
    );
  }
  const lifecycle = raw.lifecycle;
  if (
    lifecycle !== undefined &&
    lifecycle !== "drafting" &&
    lifecycle !== "queued" &&
    lifecycle !== "active"
  ) {
    throw new ChangesetError(
      `Unknown edge lifecycle "${String(lifecycle)}".`,
      "invalid_edge_lifecycle",
      400,
      index,
    );
  }
  if (raw.relation_props !== undefined && !plainObject(raw.relation_props)) {
    throw new ChangesetError(
      "relation_props must be an object.",
      "invalid_relation_props",
      400,
      index,
    );
  }
  const props = (raw.relation_props ?? {}) as Record<string, unknown>;
  const accepted = new Set(spec.acceptsProps ?? []);
  const stringProp = (name: string, explicit?: unknown): string | null => {
    if (!accepted.has(name)) return null;
    const value = explicit ?? props[name];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  return {
    kind,
    from: resolveReference(raw.from, aliases, index),
    to: resolveReference(raw.to, aliases, index),
    ...(lifecycle ? { lifecycle } : {}),
    label: stringProp("label", raw.label),
    condition: stringProp("condition", raw.condition),
    kindMetadata: stringProp("kind"),
  };
}

async function loadDeterministicPolicies(
  client: PoolClient,
  collectionId: string,
): Promise<LoadedPolicy[]> {
  const result = await client.query<{ id: string; data: Record<string, unknown> | null }>(
    `SELECT id, data
       FROM policies
      WHERE collection_id = $1
        AND COALESCE(lifecycle, 'active') = 'active'
        AND data->>'kind' = 'deterministic'`,
    [collectionId],
  );
  const policies: LoadedPolicy[] = [];
  for (const row of result.rows) {
    const data = row.data;
    if (!data || !plainObject(data.predicate)) continue;
    const onViolation = data.on_violation;
    const lifecycles = Array.isArray(data.fires_when_node_lifecycle)
      ? data.fires_when_node_lifecycle.filter(
          (value): value is Lifecycle => typeof value === "string" && LIFECYCLES.has(value),
        )
      : undefined;
    policies.push({
      policy_id: row.id,
      kind: "deterministic",
      predicate: data.predicate as LoadedPolicy["predicate"],
      ...(onViolation === "block" || onViolation === "warn" || onViolation === "log"
        ? { on_violation: onViolation }
        : {}),
      ...(lifecycles ? { fires_when_node_lifecycle: lifecycles } : {}),
    });
  }
  return policies;
}

async function evaluateDeterministicPolicies(
  client: PoolClient,
  collectionId: string,
  candidate: CandidateFields,
): Promise<{ policy_id: string; reason: string; on_violation: "block" | "warn" | "log" }[]> {
  let policies = await loadDeterministicPolicies(client, collectionId);
  if (candidate.lifecycle === "retired") {
    policies = policies.filter(
      (policy) =>
        isDeterministicPredicate(policy.predicate) &&
        RETIRED_POLICY_KINDS.has(policy.predicate.sub_kind),
    );
  }
  if (policies.length === 0) return [];
  const edges = (
    await client.query<EngineEdge>(
      `SELECT from_id, to_id, edge_type
         FROM edges
        WHERE collection_id = $1 AND COALESCE(lifecycle, 'active') <> 'retired'`,
      [collectionId],
    )
  ).rows;
  const rows = (
    await client.query<{
      id: string;
      node_type: string;
      lifecycle: Lifecycle;
      prose: string;
      kind: string | null;
      locator: string | null;
      extra: Record<string, unknown> | null;
    }>(
      `SELECT id, node_type, lifecycle, prose, kind, locator, extra
         FROM nodes
        WHERE collection_id = $1 AND id <> $2
          AND COALESCE(lifecycle, 'active') = 'active'`,
      [collectionId, candidate.id],
    )
  ).rows;
  const population = rows.map(
    (row) =>
      ({
        ...(row.extra ?? {}),
        id: row.id,
        node_type: row.node_type,
        lifecycle: row.lifecycle,
        prose: row.prose,
        ...(row.kind ? { kind: row.kind } : {}),
        ...(row.locator ? { locator: row.locator } : {}),
      }) as CandidateFields,
  );
  const principals = new Set(
    rows.filter((row) => row.node_type === "principal").map((row) => row.id),
  );
  return evaluatePolicies({
    candidate,
    policies,
    candidateEdges: edges.filter((edge) => edge.from_id === candidate.id),
    edges,
    principals,
    population,
  }).map(({ policy_id, reason, on_violation }) => ({ policy_id, reason, on_violation }));
}

interface EdgeEndpoint {
  id: string;
  node_type: string;
  lifecycle: string;
}

async function applyRelation(
  client: PoolClient,
  txId: number,
  collection: CollectionAccess,
  actorId: string,
  operationIndex: number,
  relation: PreparedRelation,
  reason: string | null,
): Promise<{ relation: RelationResult; warnings: { policy_id: string; reason: string }[] }> {
  const endpointResult = await client.query<EdgeEndpoint>(
    `SELECT id, node_type, lifecycle
       FROM nodes
      WHERE collection_id = $1 AND id = ANY($2::text[])`,
    [collection.id, [relation.from, relation.to]],
  );
  const endpoints = new Map(endpointResult.rows.map((endpoint) => [endpoint.id, endpoint]));
  const from = endpoints.get(relation.from);
  const to = endpoints.get(relation.to);
  if (!from || !to) {
    const missing = [...(!from ? [relation.from] : []), ...(!to ? [relation.to] : [])];
    throw new ChangesetError(
      `Relation endpoint${missing.length === 1 ? "" : "s"} not found in this collection: ${missing.join(", ")}.`,
      "relation_endpoint_not_found",
      404,
      operationIndex,
    );
  }
  const spec = RELATION_CATALOG[relation.kind];
  const invalidFrom = spec.endpointTypes?.from && !spec.endpointTypes.from.includes(from.node_type);
  const invalidTo = spec.endpointTypes?.to && !spec.endpointTypes.to.includes(to.node_type);
  if (invalidFrom || invalidTo) {
    throw new ChangesetError(
      `${relation.kind} does not accept ${from.node_type} -> ${to.node_type}.`,
      "invalid_relation_endpoint_type",
      422,
      operationIndex,
    );
  }
  const policies = await loadDeterministicPolicies(client, collection.id);
  const violations = evaluateEdgePolicies({
    edge: {
      edge_type: relation.kind,
      from_node_type: from.node_type,
      to_node_type: to.node_type,
    },
    policies,
    includeProbabilistic: false,
  });
  const blocking = violations.find((violation) => violation.on_violation === "block");
  if (blocking) {
    throw new ChangesetError(blocking.reason, "authoring_policy_failed", 422, operationIndex);
  }
  const lifecycle =
    relation.lifecycle ??
    (from.lifecycle === "active" && to.lifecycle === "active" ? "active" : "drafting");
  try {
    const edge = await createEdge(client, txId, {
      collectionId: collection.id,
      edgeType: relation.kind,
      fromId: from.id,
      fromNodeType: from.node_type,
      toId: to.id,
      toNodeType: to.node_type,
      label: relation.label,
      condition: relation.condition,
      kind: relation.kindMetadata,
      lifecycle,
      actor: actorId,
    });
    await appendAuditEventRow(
      {
        event_id: `evt_${generateUlid()}`,
        at: isoTimestamp(edge.created_at),
        by_user: actorId,
        collection_id: collection.id,
        workspace_id: collection.workspace_id,
        entity_type: relation.kind,
        entity_id: edge.id,
        op: "edge.add",
        after_json: edge as unknown as Record<string, unknown>,
        reason,
      },
      client,
    );
    return {
      relation: {
        kind: relation.kind,
        from: relation.from,
        to: relation.to,
        edge_id: edge.id,
      },
      warnings: violations
        .filter((violation) => violation.on_violation === "warn")
        .map(({ policy_id, reason: warningReason }) => ({
          policy_id,
          reason: warningReason,
        })),
    };
  } catch (error) {
    if (error instanceof ChangesetError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(EDGE_ENDPOINTS_NOT_ACTIVE)) {
      throw new ChangesetError(message, EDGE_ENDPOINTS_NOT_ACTIVE, 422, operationIndex);
    }
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code === "23505" && pgError.constraint === "edges_live_uniq") {
      throw new ChangesetError(
        "That live relation already exists.",
        "relation_already_exists",
        409,
        operationIndex,
      );
    }
    throw error;
  }
}

/**
 * Apply the public changeset contract through one transaction. The immutable
 * versions and audit rows are committed with the current-state projection, so
 * a record can never exist without its provenance (or vice versa).
 */
export async function applyChangeset(
  client: PoolClient,
  input: ApplyChangesetInput,
): Promise<ApplyChangesetResult> {
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new ChangesetError("operations must be a non-empty array.", "operations_required");
  }
  if (input.operations.length > 50) {
    throw new ChangesetError("changesets accept at most 50 operations.", "too_many_operations");
  }
  const found = await client.query<CollectionAccess>(
    `SELECT c.id, c.workspace_id, c.default_node_lifecycle,
            cu.role AS collection_role, cu.write_types AS collection_write_types,
            wu.role AS workspace_role, wu.write_types AS workspace_write_types
       FROM collections c
       LEFT JOIN collection_users cu ON cu.collection_id = c.id AND cu.user_id = $2
       LEFT JOIN workspace_users wu ON wu.workspace_id = c.workspace_id AND wu.user_id = $2
      WHERE c.handle = $1 AND c.deleted_at IS NULL`,
    [input.collectionHandle, input.actorId],
  );
  const collection = found.rows[0];
  if (!collection) {
    throw new ChangesetError("Collection not found.", "collection_not_found", 404);
  }
  if (!collection.collection_role && !collection.workspace_role) {
    throw new ChangesetError("Collection not found.", "collection_not_found", 404);
  }

  const aliases = new Map<string, string>();
  const prepared = input.operations.map((operation, index) =>
    prepareOperation(operation, index, collection, input.actorId, aliases),
  );

  await client.query("BEGIN");
  try {
    const txId = await createChangeset(client, {
      collectionId: collection.id,
      actor: input.actorId,
      source: input.source ?? "api",
      reason: input.reason ?? null,
      metadata: input.metadata ?? null,
    });
    const results: ChangesetOperationResult[] = [];
    for (const [index, operation] of prepared.entries()) {
      if (operation.op === "relate") {
        const applied = await applyRelation(
          client,
          txId,
          collection,
          input.actorId,
          index,
          operation,
          input.reason ?? null,
        );
        results.push({
          op_index: index,
          op: "relate",
          ok: true,
          relation: applied.relation,
          ...(applied.warnings.length > 0 ? { warnings: applied.warnings } : {}),
        });
        continue;
      }
      if (operation.op === "relate_many") {
        const relations: RelationResult[] = [];
        const warnings: { policy_id: string; reason: string }[] = [];
        for (const relation of operation.relations) {
          const applied = await applyRelation(
            client,
            txId,
            collection,
            input.actorId,
            index,
            relation,
            input.reason ?? null,
          );
          relations.push(applied.relation);
          warnings.push(...applied.warnings);
        }
        results.push({
          op_index: index,
          op: "relate_many",
          ok: true,
          relations,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
        continue;
      }
      const violations = await evaluateDeterministicPolicies(
        client,
        collection.id,
        operation.fields as CandidateFields,
      );
      const blocking = violations.find((violation) => violation.on_violation === "block");
      if (blocking) {
        throw new ChangesetError(blocking.reason, "authoring_policy_failed", 422, index);
      }
      await upsertNode(nodeRowFromFields(operation.nodeType, operation.fields), client);
      await appendNodeVersion(client, {
        entityId: String(operation.fields.id),
        entityType: operation.nodeType,
        op: "create",
        payload: operation.fields,
        txId,
        actor: input.actorId,
      });
      await appendAuditEventRow(
        {
          event_id: `evt_${generateUlid()}`,
          at: String(operation.fields.created_at),
          by_user: input.actorId,
          collection_id: collection.id,
          workspace_id: collection.workspace_id,
          entity_type: operation.nodeType,
          entity_id: String(operation.fields.id),
          op: "entity.create",
          after_json: operation.fields,
          reason: input.reason ?? null,
        },
        client,
      );
      results.push({
        op_index: index,
        op: "create",
        ok: true,
        id: String(operation.fields.id),
        ...(operation.alias ? { alias: operation.alias } : {}),
        ...(violations.some((violation) => violation.on_violation === "warn")
          ? {
              warnings: violations
                .filter((violation) => violation.on_violation === "warn")
                .map(({ policy_id, reason }) => ({ policy_id, reason })),
            }
          : {}),
      });
    }
    await client.query("COMMIT");
    return {
      ok: true,
      results,
      aliases: Object.fromEntries(aliases),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export const AUTHORABLE_NODE_TYPES = Object.keys(CAPTURE_SCHEMAS) as CatalogNodeType[];
