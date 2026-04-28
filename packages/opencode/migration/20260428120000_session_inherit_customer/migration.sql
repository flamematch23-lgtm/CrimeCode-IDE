-- Auto-inherit session.customer_id from the parent project on every INSERT.
-- This avoids touching every session-create code path (projectors, import,
-- compaction, fork, …) — wherever a session row is born, the trigger copies
-- the project's owner into the new row.
--
-- Why a trigger instead of a generated/computed column: project.customer_id
-- can change (tag-on-touch when a legacy project first meets its Bearer
-- owner), and the project may not exist yet at the moment of the session
-- INSERT in some test scenarios. A trigger reads the freshly-current value
-- and only fires when the row didn't already specify one.
CREATE TRIGGER `session_inherit_customer_id`
AFTER INSERT ON `session`
FOR EACH ROW
WHEN NEW.customer_id IS NULL
BEGIN
  UPDATE `session`
  SET customer_id = (SELECT customer_id FROM `project` WHERE id = NEW.project_id)
  WHERE id = NEW.id;
END;
