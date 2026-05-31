-- 067_drop_dead_audit_ops.sql — tighten the audit_events op CHECK to the
-- four ops actually written post-vnext.
--
-- `entity.delete` is dead: removal is never a hard delete — it is a
-- lifecycle.transition to "retired" (see $docoHandle.api.$type.txt and
-- the doco-vnext append-only history model). Nothing in the codebase ever
-- emits op='entity.delete', and the genesis reset (migration 063) means no
-- historical rows carry it either, so narrowing the CHECK rejects nothing
-- that exists. `edge.add` STAYS — capture.server.ts still emits it for
-- additive edge-only patches (e.g. intent_ids).
--
-- The baseline CHECK in schema.sql is unnamed, so Postgres auto-named it
-- `audit_events_op_check`. Drop and re-add with the narrowed allow-list.

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_op_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_op_check
  CHECK (op IN ('entity.create', 'entity.update', 'lifecycle.transition', 'edge.add'));
