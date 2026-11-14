-- A chat keeps one Log. Each time an agent rewrote it, the rewrite saved a new
-- Log, retired the one before and linked them with a `replaces` edge, so since
-- Logs were saved active (2026-10-26) every chat left its earlier drafts
-- retired and struck through in activity feeds. Hosted Braino now revises a
-- chat's Log in place instead (hosted-braino#1784), and Alexander asked to
-- bring the drafts already retired back (2026-11-14, "Force an update to
-- unretire them"). A Log another Log replaced was retired by a rewrite, not
-- withdrawn, so it is active again; a Log retired on purpose, and any other
-- node a newer one replaced, stays retired. updated_at stays as it was, as in
-- the 2026-10-26 fix: a fresh one would put every old draft in this week's
-- briefs.
UPDATE nodes n
   SET lifecycle = 'active'
 WHERE n.node_type = 'log'
   AND n.lifecycle = 'retired'
   AND EXISTS (
         SELECT 1 FROM edges e
          WHERE e.to_id = n.id AND e.edge_type = 'replaces' AND e.from_node_type = 'log');
