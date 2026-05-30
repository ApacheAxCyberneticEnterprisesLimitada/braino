-- 059_glossary_perspective.sql
-- ============================================================
-- Add the `glossary` perspective kind and seed the built-in
-- Glossary perspective used by the glossaries template.
--
-- The perspective renders the Doco's term entries (Decisions:
-- `chosen` is the canonical headword, `decision` prose is the
-- definition, `data.question` is the concept, `alternatives` are
-- aliases / deprecated wording) as a printed-dictionary page —
-- serif headwords, a faux pronunciation respelling, A–Z thumb
-- index, and guide words. It reads the same Decisions the List
-- perspective shows; only the presentation differs.
-- ============================================================

ALTER TABLE perspectives DROP CONSTRAINT IF EXISTS perspectives_kind_check;
ALTER TABLE perspectives
  ADD CONSTRAINT perspectives_kind_check
  CHECK (kind IN ('graph', 'list', 'bpmn', 'org-tree', 'sla', 'approval', 'glossary'));

INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config)
VALUES
  ('perspective_glossary',
   'glossary',
   'glossary',
   'Glossary',
   'A dictionary-style reading of the Doco''s terminology — canonical headwords, definitions, senses, and aliases laid out like a printed lexicon.',
   '📖',
   NULL,
   true,
   '{"primary_entity":"decision","headword_field":"chosen","definition_field":"decision"}'::jsonb)
ON CONFLICT (id) DO NOTHING;
