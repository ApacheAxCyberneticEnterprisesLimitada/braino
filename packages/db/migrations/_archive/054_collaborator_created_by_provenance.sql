-- 054_collaborator_created_by_provenance.sql
-- ============================================================
-- `created_by`, `updated_by`, and audit_events.by_collaborator are
-- provenance fields. They identify the collaborator/API actor that
-- performed the write, never the Principal neuron referenced by the
-- modeled process. Older capture paths incorrectly copied
-- `*_principal_id` values into those provenance fields; repair rows
-- where the Principal can be traced back to a collaborator.
-- ============================================================

BEGIN;

CREATE TEMP TABLE _doco_principal_creator_resolution ON COMMIT DROP AS
SELECT p.id AS principal_id,
       COALESCE(
         CASE WHEN left(p.created_by, 13) = 'collaborator_' THEN p.created_by END,
         CASE WHEN left(p.data->>'owner_id', 13) = 'collaborator_' THEN p.data->>'owner_id' END,
         CASE WHEN left(p.data->>'created_by', 13) = 'collaborator_' THEN p.data->>'created_by' END
       ) AS collaborator_id
  FROM principals p;

DELETE FROM _doco_principal_creator_resolution
 WHERE collaborator_id IS NULL;

DO $provenance_repair$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'intents',
    'decisions',
    'rules',
    'guidance_policies',
    'neuron_authoring_policies',
    'actions',
    'logs',
    'evals',
    'states',
    'ideas',
    'reference_entities',
    'principals'
  ]
  LOOP
    EXECUTE format(
      'UPDATE %I target
          SET created_by = r.collaborator_id
         FROM _doco_principal_creator_resolution r
        WHERE target.created_by = r.principal_id',
      table_name
    );

    EXECUTE format(
      'UPDATE %I target
          SET updated_by = r.collaborator_id
         FROM _doco_principal_creator_resolution r
        WHERE target.updated_by = r.principal_id',
      table_name
    );

    EXECUTE format(
      'UPDATE %I target
          SET data = jsonb_set(target.data, ''{created_by}'', to_jsonb(r.collaborator_id), true)
         FROM _doco_principal_creator_resolution r
        WHERE target.data->>''created_by'' = r.principal_id',
      table_name
    );

    EXECUTE format(
      'UPDATE %I target
          SET data = jsonb_set(target.data, ''{updated_by}'', to_jsonb(r.collaborator_id), true)
         FROM _doco_principal_creator_resolution r
        WHERE target.data->>''updated_by'' = r.principal_id',
      table_name
    );
  END LOOP;
END $provenance_repair$;

-- Ideas are proposed by collaborators in the schema, not Principal
-- neurons. Repair rows written by the same legacy capture path.
UPDATE ideas target
   SET proposer_id = r.collaborator_id
  FROM _doco_principal_creator_resolution r
 WHERE target.proposer_id = r.principal_id;

UPDATE ideas target
   SET data = jsonb_set(target.data, '{proposer_id}', to_jsonb(r.collaborator_id), true)
  FROM _doco_principal_creator_resolution r
 WHERE target.data->>'proposer_id' = r.principal_id;

UPDATE audit_events target
   SET by_collaborator = r.collaborator_id
  FROM _doco_principal_creator_resolution r
 WHERE target.by_collaborator = r.principal_id;

COMMIT;
