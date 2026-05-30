-- 043_chat_conversation_doco_ids.sql
-- ============================================================
-- Señor Doco conversation attachments must survive Doco handle
-- changes. The legacy `attached_doco_handles` array was useful for
-- display, but handles are mutable. Store stable doco ids instead;
-- keep the handle array only as a legacy read/backfill source.
-- ============================================================

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS attached_doco_ids TEXT[] NOT NULL DEFAULT '{}';

UPDATE chat_conversations cc
   SET attached_doco_ids = COALESCE(
     (
       SELECT array_agg(x.id ORDER BY x.first_seen)
         FROM (
           SELECT DISTINCT ON (d.id) d.id, h.ord AS first_seen
             FROM unnest(cc.attached_doco_handles) WITH ORDINALITY AS h(handle, ord)
             JOIN docos d ON d.handle = h.handle
            ORDER BY d.id, h.ord
         ) AS x
     ),
     '{}'
   )
 WHERE array_length(cc.attached_doco_ids, 1) IS NULL
   AND array_length(cc.attached_doco_handles, 1) IS NOT NULL;
