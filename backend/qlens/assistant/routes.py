from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator

from qlens import db
from qlens.assistant import service
from qlens.assistant.llm import ChatModel, configured_model
from qlens.assistant.service import AssistantReply, ConversationDetail, ConversationOut, UndoOut
from qlens.auth.deps import owned_workspace
from qlens.errors import ApiError
from qlens.workspaces.service import WorkspaceRow

router = APIRouter(prefix="/workspaces/{workspace_id}/assistant", tags=["assistant"])


class AssistantIn(BaseModel):
    message: Annotated[str, Field(min_length=1, max_length=2000)]
    conversation_id: int | None = None
    context: Literal["design", "query", "data"] = "design"

    @field_validator("message")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Type a message.")
        return v


def chat_model() -> ChatModel:
    """The model, or 503 when no GEMINI_API_KEY is configured. Tests override this dependency."""
    model = configured_model()
    if model is None:
        raise ApiError(503, "assistant_disabled", "The assistant is off: no GEMINI_API_KEY is set on the server.")
    return model


# Sync: the model and the tools block, so FastAPI runs this in its threadpool.
@router.post("")
def ask(body: AssistantIn, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace),
        model: ChatModel = Depends(chat_model)) -> AssistantReply:
    return service.respond(conn, ws.id, ws.owner_id, body.message, body.conversation_id, body.context, model)


@router.post("/undo")
def undo(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> UndoOut:
    """Go back one design version, as the assistant's undo tool does, without asking the model."""
    return service.undo(conn, ws.id)


@router.get("/conversations")
def conversations(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> list[ConversationOut]:
    return service.list_conversations(conn, ws.id)


@router.get("/conversations/{conversation_id}")
def conversation(conversation_id: int, conn: db.Conn,
                 ws: WorkspaceRow = Depends(owned_workspace)) -> ConversationDetail:
    return service.get_conversation(conn, ws.id, conversation_id)
