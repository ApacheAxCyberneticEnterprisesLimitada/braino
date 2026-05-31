-- 070_restore_node_ref_fks.sql — restore database-level referential integrity
-- for the unified `nodes` table and the `edges` table.
--
-- Migration 013 promoted the scalar id refs into typed columns WITH real FK
-- constraints. The node-table collapse (064) merged the 10 per-type tables
-- into `nodes` and dropped those FKs; the schema comment at the time framed
-- app-level enforcement as a necessity ("every inbound FK came from another
-- node table, so none survives the collapse"). That was a choice, not a
-- consequence: every node target now lives in `nodes`, so the old cross-table
-- FKs become self-referential FKs, which Postgres supports. This restores the
-- full set — consistency at the database level by default.
--
-- nodes — six promoted relationship columns, all FK'd:
--   parent_intent_id          → nodes(id)   (intent → intent)
--   superseded_by_decision_id → nodes(id)   (decision → decision)
--   actor_id                  → nodes(id)   (action/log → principal)
--   template_id               → nodes(id)   (log → action)
--   decided_by                → nodes(id)   (decision → principal). Migration
--       025 dropped its FK after a prod outage (it then pointed at the wrong
--       table, collaborators, and a boot-time VALIDATE over the bad data
--       500'd every request). 056 repaired the values from the `data` jsonb;
--       the contract is now EntityId<"principal"> and principals live in
--       `nodes`, so the self-FK is correct. NOT VALID keeps the 025 lesson:
--       never scan existing rows at boot.
--   proposer_id               → users(id) ON DELETE SET NULL. This one is NOT
--       a node — it holds the OAuth identity that proposed an idea (013 FK'd
--       it to collaborators(id); 056 confirms "its FK to users(id) is
--       legitimate"). Different table, hence its own target + SET NULL.
--
-- edges — endpoints are nodes, full stop:
--   from_id → nodes(id), to_id → nodes(id). Org/doco containment rides on the
--   doco_id / org_id columns; membership lives in doco_users / org_users.
--   Nothing legitimately writes a non-node edge endpoint (deriveEdges output
--   is never persisted; captureEdge now also rejects non-node endpoints), so
--   the FK only forbids what the invariant already forbids.
--
-- Constraint shape:
--   * DEFERRABLE INITIALLY DEFERRED on the node self-FKs and the edge
--     endpoints — a changeset writes node + edge + version rows in one
--     transaction (withTransaction) and may reference a row created later in
--     the same txn; the check runs at COMMIT. It also lets a `docos`
--     ON DELETE CASCADE clear a whole doco's nodes + edges without tripping
--     mid-cascade. (proposer_id → users needs neither: a proposer always
--     pre-exists, so it is plain ON DELETE SET NULL.)
--   * NOT VALID — enforces all NEW writes without the full-table validation
--     scan. Existing rows are NOT checked here; that is the explicit lesson
--     from migration 025. A later operator-run `VALIDATE CONSTRAINT` after an
--     orphan audit can promote each constraint to fully validated.
--
-- Idempotent: guarded on table existence (a fresh genesis bootstrap drops
-- these tables between the two schema.sql passes — see migration 064's note,
-- so this is a no-op there and the inline FKs in schema.sql apply instead) and
-- on each constraint's prior existence.

DO $do$
BEGIN
  IF to_regclass('public.nodes') IS NOT NULL THEN
    -- Visibility only (never fails the migration): how many existing rows
    -- would a future VALIDATE reject? Operators read these from the logs.
    RAISE NOTICE '070 node-ref orphan pre-check: parent_intent_id=%, superseded_by_decision_id=%, actor_id=%, template_id=%, decided_by=%, proposer_id(→users)=%',
      (SELECT count(*) FROM nodes c WHERE c.parent_intent_id          IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = c.parent_intent_id)),
      (SELECT count(*) FROM nodes c WHERE c.superseded_by_decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = c.superseded_by_decision_id)),
      (SELECT count(*) FROM nodes c WHERE c.actor_id                  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = c.actor_id)),
      (SELECT count(*) FROM nodes c WHERE c.template_id               IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = c.template_id)),
      (SELECT count(*) FROM nodes c WHERE c.decided_by                IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = c.decided_by)),
      (SELECT count(*) FROM nodes c WHERE c.proposer_id               IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.proposer_id));

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_parent_intent_fk') THEN
      ALTER TABLE nodes ADD CONSTRAINT nodes_parent_intent_fk
        FOREIGN KEY (parent_intent_id) REFERENCES nodes(id)
        DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_superseded_by_decision_fk') THEN
      ALTER TABLE nodes ADD CONSTRAINT nodes_superseded_by_decision_fk
        FOREIGN KEY (superseded_by_decision_id) REFERENCES nodes(id)
        DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_actor_fk') THEN
      ALTER TABLE nodes ADD CONSTRAINT nodes_actor_fk
        FOREIGN KEY (actor_id) REFERENCES nodes(id)
        DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_template_fk') THEN
      ALTER TABLE nodes ADD CONSTRAINT nodes_template_fk
        FOREIGN KEY (template_id) REFERENCES nodes(id)
        DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_decided_by_fk') THEN
      ALTER TABLE nodes ADD CONSTRAINT nodes_decided_by_fk
        FOREIGN KEY (decided_by) REFERENCES nodes(id)
        DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_proposer_fk') THEN
      ALTER TABLE nodes ADD CONSTRAINT nodes_proposer_fk
        FOREIGN KEY (proposer_id) REFERENCES users(id)
        ON DELETE SET NULL NOT VALID;
    END IF;
  ELSE
    RAISE NOTICE '070: nodes table absent (fresh genesis bootstrap) — schema.sql inline FKs apply instead';
  END IF;

  IF to_regclass('public.edges') IS NOT NULL THEN
    RAISE NOTICE '070 edge-endpoint orphan pre-check: from_id(non-node)=%, to_id(non-node)=%',
      (SELECT count(*) FROM edges e WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.from_id)),
      (SELECT count(*) FROM edges e WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.to_id));

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edges_from_fk') THEN
      ALTER TABLE edges ADD CONSTRAINT edges_from_fk
        FOREIGN KEY (from_id) REFERENCES nodes(id)
        DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edges_to_fk') THEN
      ALTER TABLE edges ADD CONSTRAINT edges_to_fk
        FOREIGN KEY (to_id) REFERENCES nodes(id)
        DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;
  END IF;
END
$do$;
