-- Align Principal.type values across the codebase: the entity type field
-- in @doco/shared is `("person" | "agent")` and predicate filters
-- (AuthoringPredicate.allowed_principal_types) read "person", but the
-- schema CHECK was `('human','agent')` and write paths inserted "human".
-- This migration moves storage to "person" so reads and writes match.

ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_type_check;
UPDATE principals SET type = 'person' WHERE type = 'human';
ALTER TABLE principals
  ADD CONSTRAINT principals_type_check CHECK (type IN ('person', 'agent'));
