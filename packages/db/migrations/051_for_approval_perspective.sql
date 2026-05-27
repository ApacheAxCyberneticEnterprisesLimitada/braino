-- ============================================================
-- Add the built-in "Proposed" perspective.
--
-- This surface is a queue of proposed neurons, with direct approve /
-- reject actions and a zoom link back to the Doco's default
-- perspective focused on the neuron.
-- ============================================================

ALTER TABLE perspectives DROP CONSTRAINT IF EXISTS perspectives_kind_check;
ALTER TABLE perspectives
  ADD CONSTRAINT perspectives_kind_check
  CHECK (kind IN ('graph', 'list', 'bpmn', 'org-tree', 'sla', 'approval'));

INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config)
VALUES
  ('perspective_approval',
   'for-approval',
   'approval',
   'Proposed',
   'Queue of proposed neurons waiting for review.',
   NULL,
   NULL,
   true,
   '{"lifecycle":"proposed","approve_lifecycle":"active","reject_lifecycle":"drafting"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM doco_perspectives WHERE perspective_id = 'perspective_approval'
  ) THEN
    UPDATE doco_perspectives
       SET position = position + 1
     WHERE position >= 2;
  END IF;
END $$;

INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default)
SELECT d.id, 'perspective_approval', 2, false
  FROM docos d
ON CONFLICT (doco_id, perspective_id) DO NOTHING;
