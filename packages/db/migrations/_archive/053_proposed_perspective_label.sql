-- Rename the approval queue tab from "Propose" to "Proposed".

UPDATE perspectives
   SET name = 'Proposed',
       updated_at = now()
 WHERE id = 'perspective_approval'
   AND name = 'Propose';
