import {
  type CommitSource,
  type PoolClient,
  appendAuditEventRow,
  appendNodeVersion,
  createChangeset,
  nodeRowFromFields,
  upsertNode,
} from "@doco/db";
import {
  BLOCKED_NODE_JSON_EDGE_FIELD_SET,
  CAPTURE_SCHEMAS,
  type CandidateFields,
  type CatalogNodeType,
  type EngineEdge,
  type Lifecycle,
  type LoadedPolicy,
  canWriteType,
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
  op: "create";
  ok: true;
  id: string;
  alias?: string;
  warnings?: { policy_id: string; reason: string }[];
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
  nodeType: GenericNodeType;
  alias?: string;
  fields: Record<string, unknown>;
}

const RETIRED_POLICY_KINDS = new Set([
  "requires_entity_type",
  "requires_node_type",
  "forbids_edge",
  "forbids_field",
]);

function role(value: string | null): "owner" | "writer" | "reader" | null {
  return value === "owner" || value === "writer" || value === "reader" ? value : null;
}

function grantAllows(rawRole: string | null, rawTypes: string[] | null, nodeType: GenericNodeType) {
  const grantRole = role(rawRole);
  const writeTypes = normalizeWriteTypes(rawTypes);
  if (grantRole === "writer" && writeTypes.length === 0) writeTypes.push("*");
  return canWriteType(grantRole, writeTypes, nodeType);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  aliases: Set<string>,
): PreparedCreate {
  if (!plainObject(raw) || raw.op !== "create") {
    throw new ChangesetError(
      `Unsupported operation "${plainObject(raw) ? String(raw.op) : "invalid"}". This release supports create operations.`,
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
  if (alias) aliases.add(alias);
  const now = new Date().toISOString();
  const id = `${nodeType}_${generateUlid()}`;
  return {
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

  const aliases = new Set<string>();
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
      aliases: Object.fromEntries(
        results.flatMap((result) => (result.alias ? [[result.alias, result.id]] : [])),
      ),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export const AUTHORABLE_NODE_TYPES = Object.keys(CAPTURE_SCHEMAS) as CatalogNodeType[];
