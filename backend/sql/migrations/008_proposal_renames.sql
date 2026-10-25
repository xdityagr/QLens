-- Whether a proposal's names differ from what synthesis gave it: set by a rename, carried over when a
-- version is copied (edit the applied design, the assistant's versions and undo). The Design screen asks
-- before a Rebuild only when it would throw renames away.
ALTER TABLE qlens.schema_proposals ADD COLUMN has_renames boolean NOT NULL DEFAULT false;
