-- The workspace assistant (Gemini with function calling): conversations, their messages and every
-- tool call the model made, plus the version chain that lets the assistant undo its design edits.
-- Conventions as in 001_schema.sql.

-- ---------------------------------------------------------------------------------------------
-- Design versions
-- ---------------------------------------------------------------------------------------------

-- Every assistant edit makes a new draft (the old one is kept as 'superseded'); based_on_id is
-- the proposal the draft was made from, so "undo" copies that one back as the new draft and
-- repeated undos walk further back along the chain. NULL for a draft synthesized from scratch.
-- SET NULL: losing an old version must not delete the drafts made from it.
ALTER TABLE qlens.schema_proposals
    ADD COLUMN based_on_id bigint REFERENCES qlens.schema_proposals (id) ON DELETE SET NULL;
-- Serves the ON DELETE SET NULL above (deleting a version finds the drafts made from it).
-- Partial: most proposals are synthesized, not derived.
CREATE INDEX schema_proposals_based_on_idx ON qlens.schema_proposals (based_on_id)
    WHERE based_on_id IS NOT NULL;

-- Dependency flips made on the way to this draft, as {"<fd id>": previous accepted flag}. Undo puts
-- those flags back, so going back to the previous design also brings back the dependencies it used.
-- NULL when the version involved no flip.
ALTER TABLE qlens.schema_proposals ADD COLUMN fd_changes jsonb;
COMMENT ON COLUMN qlens.schema_proposals.fd_changes IS
    'functional_dependencies.accepted values before the flips that produced this draft: {"<fd id>": bool}';

-- ---------------------------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------------------------

-- One chat thread in a workspace. context is the screen it was started on: on the Design screen
-- the assistant may edit the draft design, on the Query and Data screens it only answers and runs SELECTs.
CREATE TABLE qlens.assistant_conversations (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id bigint NOT NULL REFERENCES qlens.workspaces (id) ON DELETE CASCADE,
    context      text NOT NULL CHECK (context IN ('design', 'query', 'data')),
    title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()   -- maintained by touch_updated_at()
);
-- Serves "conversations of this workspace, most recent first" and the cascade from workspaces.
CREATE INDEX assistant_conversations_workspace_idx
    ON qlens.assistant_conversations (workspace_id, updated_at DESC);

CREATE TRIGGER assistant_conversations_touch BEFORE UPDATE ON qlens.assistant_conversations
    FOR EACH ROW EXECUTE FUNCTION qlens.touch_updated_at();

-- One turn of a conversation. intent is set on assistant messages only: 'edit' when at least one
-- edit tool succeeded while answering it, else 'answer'.
CREATE TABLE qlens.assistant_messages (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id bigint NOT NULL REFERENCES qlens.assistant_conversations (id) ON DELETE CASCADE,
    seq             integer NOT NULL CHECK (seq >= 1),
    role            text NOT NULL CHECK (role IN ('user', 'assistant')),
    content         text NOT NULL,
    intent          text CHECK (intent IN ('answer', 'edit')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK ((role = 'assistant') = (intent IS NOT NULL)),
    -- Leads with conversation_id: serves "messages of this conversation in order" (history replay,
    -- the conversation view, message counts) and the cascade from conversations.
    UNIQUE (conversation_id, seq)
);

-- A function call the model made while producing an assistant message, with what came back.
-- args/result are the JSON exchanged with the model; error is set exactly when the call failed.
CREATE TABLE qlens.assistant_tool_calls (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id   bigint NOT NULL REFERENCES qlens.assistant_messages (id) ON DELETE CASCADE,
    seq          smallint NOT NULL CHECK (seq >= 1),
    tool         text NOT NULL,
    args         jsonb NOT NULL,
    ok           boolean NOT NULL,
    result       jsonb,
    error        text,
    -- The query history row of a run_sql call. SET NULL: clearing history keeps the chat intact.
    query_run_id bigint REFERENCES qlens.query_runs (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (ok = (error IS NULL)),
    -- Leads with message_id: serves "tool calls of this message in order" and the cascade.
    UNIQUE (message_id, seq)
);
-- Serves the ON DELETE SET NULL from query_runs. Partial: only run_sql calls have a run.
CREATE INDEX assistant_tool_calls_query_run_idx ON qlens.assistant_tool_calls (query_run_id)
    WHERE query_run_id IS NOT NULL;
