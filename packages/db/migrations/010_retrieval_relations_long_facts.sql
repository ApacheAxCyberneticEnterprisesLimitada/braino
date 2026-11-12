-- A retrieval relationship's id hashes its chunk, endpoints, type and fact, so
-- the primary key already keeps each one once. The unique key that repeated
-- those columns held the whole fact in one btree entry, and a fact past 2,704
-- bytes (a cross-repository link citing many files) failed every sync of that
-- codebase. The key goes; an index on the chunk keeps the joins and cascades
-- it served.
CREATE INDEX IF NOT EXISTS retrieval_relations_source_chunk_idx
  ON retrieval_relations (source_chunk_id);

ALTER TABLE retrieval_relations
  DROP CONSTRAINT IF EXISTS retrieval_relations_source_chunk_id_from_entity_id_to_entit_key;
