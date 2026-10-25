"""The model behind the assistant, kept behind a small protocol so tests can script it.

The service only sees ChatModel.step: given the system prompt, the conversation so far and the tool
specs, the model answers with text and/or function calls. GeminiModel implements it with the official
google-genai SDK (manual function calling: the SDK's automatic mode is off, the service runs the tools).
"""
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Literal, Protocol

from qlens.config import get_settings

CALL_TIMEOUT_MS = 30_000


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]            # JSON schema of the arguments object


@dataclass
class FunctionCall:
    name: str
    args: dict[str, Any]
    id: str | None = None


@dataclass
class ToolResult:
    name: str
    response: dict[str, Any]              # {"result": ...} or {"error": {...}}
    id: str | None = None


@dataclass
class Turn:
    role: Literal["user", "model", "tool"]
    text: str | None = None
    calls: list[FunctionCall] = field(default_factory=list)
    results: list[ToolResult] = field(default_factory=list)
    # The provider's own record of a model turn. Gemini signs its reasoning ("thought signatures") and
    # needs the signed parts back on the next call of the same tool loop, so they are replayed as is.
    raw: Any = None


@dataclass
class ModelStep:
    text: str | None
    calls: list[FunctionCall]
    raw: Any = None


class ModelError(Exception):
    """The model could not be reached or gave an unusable answer (the route turns it into a 502)."""


class ChatModel(Protocol):
    name: str

    def step(self, system: str, history: list[Turn], tools: list[ToolSpec]) -> ModelStep: ...


class GeminiModel:
    def __init__(self, api_key: str, model: str, timeout_ms: int = CALL_TIMEOUT_MS):
        from google import genai
        from google.genai import types

        self.name = model
        self._types = types
        # One retry for a brief server-side hiccup; each attempt is bounded by the timeout. Not on 429: the
        # free tier's quota is per minute, so a quick retry only spends another request.
        self._client = genai.Client(api_key=api_key, http_options=types.HttpOptions(
            timeout=timeout_ms, retry_options=types.HttpRetryOptions(attempts=2, http_status_codes=[500, 503, 504])))

    def _contents(self, history: list[Turn]) -> list:
        t = self._types
        out = []
        for turn in history:
            if turn.role == "user":
                out.append(t.Content(role="user", parts=[t.Part.from_text(text=turn.text or "")]))
            elif turn.role == "model":
                if turn.raw is not None:
                    out.append(turn.raw)
                    continue
                parts = [t.Part.from_text(text=turn.text)] if turn.text else []
                parts += [t.Part(function_call=t.FunctionCall(id=c.id, name=c.name, args=c.args)) for c in turn.calls]
                out.append(t.Content(role="model", parts=parts))
            else:
                out.append(t.Content(role="user", parts=[
                    t.Part(function_response=t.FunctionResponse(id=r.id, name=r.name, response=r.response))
                    for r in turn.results]))
        return out

    def step(self, system: str, history: list[Turn], tools: list[ToolSpec]) -> ModelStep:
        t = self._types
        config = t.GenerateContentConfig(
            system_instruction=system,
            tools=[t.Tool(function_declarations=[
                t.FunctionDeclaration(name=s.name, description=s.description, parameters_json_schema=s.parameters)
                for s in tools])] if tools else None,
            automatic_function_calling=t.AutomaticFunctionCallingConfig(disable=True),
        )
        try:
            response = self._client.models.generate_content(model=self.name, contents=self._contents(history),
                                                            config=config)
        except Exception as e:  # SDK API errors, timeouts, connection errors; none of them carry the key
            raise ModelError(f"{type(e).__name__}: {e}") from None
        candidate = response.candidates[0] if response.candidates else None
        if candidate is None or candidate.content is None:
            raise ModelError("The model returned no answer.")
        parts = candidate.content.parts or []
        text = "".join(p.text for p in parts if p.text and not p.thought) or None
        calls = [FunctionCall(name=p.function_call.name, args=dict(p.function_call.args or {}), id=p.function_call.id)
                 for p in parts if p.function_call is not None]
        if text is None and not calls:
            raise ModelError("The model returned an empty answer.")
        return ModelStep(text=text, calls=calls, raw=candidate.content)


@lru_cache
def _gemini(api_key: str, model: str) -> GeminiModel:
    return GeminiModel(api_key, model)


def configured_model() -> ChatModel | None:
    """The model from settings, or None when no GEMINI_API_KEY is set (the assistant is then disabled)."""
    s = get_settings()
    return _gemini(s.gemini_api_key, s.gemini_model) if s.gemini_api_key else None
