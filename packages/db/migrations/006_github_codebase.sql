ALTER TABLE github_connections
  ADD COLUMN IF NOT EXISTS code_collection_id text;

UPDATE github_connections g
   SET code_collection_id = (
    SELECT c.id
      FROM collections c
     WHERE c.workspace_id = g.workspace_id
       AND c.deleted_at IS NULL
       AND c.data->>'template_handle' = 'codebase'
     ORDER BY c.created_at, c.id
     LIMIT 1
   )
 WHERE g.code_collection_id IS NULL
   AND EXISTS (
     SELECT 1
       FROM collections c
      WHERE c.workspace_id = g.workspace_id
        AND c.deleted_at IS NULL
        AND c.data->>'template_handle' = 'codebase'
   );

INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, goal, data)
SELECT 'collection_code_' || md5(g.id),
       w.handle || '-codebase',
       g.workspace_id,
       g.workspace_id,
       'private',
       'A copy of your GitHub repositories'' code, kept in sync on every push, so it can be browsed and searched alongside your Braino knowledge.',
       jsonb_build_object(
         'template_handle', 'codebase',
         'github_integration', jsonb_build_object(
           'connections', jsonb_build_array(jsonb_build_object('repo', g.repository))
         )
       )
  FROM github_connections g
  JOIN workspaces w ON w.id = g.workspace_id
 WHERE g.code_collection_id IS NULL
ON CONFLICT (handle) DO NOTHING;

UPDATE github_connections g
   SET code_collection_id = c.id
  FROM collections c
 WHERE g.code_collection_id IS NULL
   AND c.workspace_id = g.workspace_id
   AND c.deleted_at IS NULL
   AND c.data->>'template_handle' = 'codebase';

UPDATE collections c
   SET data = jsonb_set(
         c.data || '{"github_integration": {}}'::jsonb,
         '{github_integration,connections}',
         jsonb_build_array(jsonb_build_object('repo', g.repository)),
         true
       ),
       updated_at = now()
  FROM github_connections g
 WHERE c.id = g.code_collection_id;

ALTER TABLE github_connections
  ALTER COLUMN code_collection_id SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE github_connections
    ADD CONSTRAINT github_connections_code_collection_fk
    FOREIGN KEY (code_collection_id) REFERENCES collections(id);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
