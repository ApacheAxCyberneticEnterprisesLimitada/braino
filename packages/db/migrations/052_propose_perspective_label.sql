-- Rename the approval queue tab to "Proposed" and remove its icon.
--
-- The slug stays `for-approval` for existing links; this only changes
-- the user-facing tab label and metadata.

UPDATE perspectives
   SET name = 'Proposed',
       description = 'Queue of proposed neurons waiting for review.',
       icon = NULL,
       updated_at = now()
 WHERE id = 'perspective_approval';
