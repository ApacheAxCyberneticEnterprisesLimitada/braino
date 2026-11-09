UPDATE hosts
   SET name = 'Braino',
       updated_at = now()
 WHERE id = 'host'
   AND name = 'Doco';

UPDATE oauth_clients
   SET client_name = 'Braino self-hosted MCP tokens'
 WHERE client_id = 'doco_self_hosted_tokens'
   AND client_name = 'Doco self-hosted MCP tokens';

UPDATE collections c
   SET goal = identity.new_goal,
       updated_at = now()
  FROM (VALUES
    ('Write and keep documents in Doco: specs, plans, notes, anything a page says best, in Markdown, searchable alongside your other knowledge.',
     'Write and keep documents in Braino: specs, plans, notes, anything a page says best, in Markdown, searchable alongside your other knowledge.'),
    ('A copy of your GitHub repositories'' code, kept in sync on every push, so it can be browsed and searched alongside your Doco knowledge.',
     'A copy of your GitHub repositories'' code, kept in sync on every push, so it can be browsed and searched alongside your Braino knowledge.'),
    ('A read-only copy of a Slack workspace''s public channels, kept in sync, so its conversations can be searched alongside your Doco knowledge.',
     'A read-only copy of a Slack workspace''s public channels, kept in sync, so its conversations can be searched alongside your Braino knowledge.'),
    ('A read-only copy of the Notion pages and databases you share, kept in sync, so they can be searched alongside your Doco knowledge.',
     'A read-only copy of the Notion pages and databases you share, kept in sync, so they can be searched alongside your Braino knowledge.'),
    ('A read-only copy of the Docs, Sheets, Slides and text files in the shared drives and folders you pick, kept in sync, so they can be searched alongside your Doco knowledge.',
     'A read-only copy of the Docs, Sheets, Slides and text files in the shared drives and folders you pick, kept in sync, so they can be searched alongside your Braino knowledge.')
  ) AS identity(old_goal, new_goal)
 WHERE c.goal = identity.old_goal;
