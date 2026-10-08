"""Hook-command hosts: one fresh adapter process per native hook event.

Hosts such as OpenAI Codex CLI hooks start a new process for every event,
pass one JSON event on stdin and read a host-shaped answer from stdout/exit
status. `Runtime` (pre -> effect -> post inside one call) does not fit that
shape. This module is its process-per-event counterpart: decode one canonical
event, consult the shipped `Client` at the right boundary, apply the decision
with `execute`/`deliver`, and report a typed outcome. It never renders a host
wire format; the host adapter does, and stays responsible for answering every
path explicitly when the host fails open on a silent or crashed hook.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import sys
import threading
from typing import Any, Callable, Literal

from . import MAX_BYTES, Client, Decision, Refused, Unavailable, _object, deliver, execute, snapshot
from .strict_json import loads as strict_loads

HOOK_COMMAND_EVENTS: dict[str, tuple[str, Literal["pre", "post", "lifecycle"]]] = {
    "SessionStart": ("session-start", "lifecycle"),
    "SessionEnd": ("session-end", "lifecycle"),
    "PreToolUse": ("pre-tool-use", "pre"),
    "PostToolUse": ("post-tool-use", "post"),
}
# Only these host fields reach the Hook. A host payload cannot smuggle prompt,
# expansion or transcript fields into a tool-call request.
_FORWARDED = ("session_id", "cwd", "hook_event_name", "tool_use_id", "tool_name",
              "tool_input", "tool_response", "agent_id", "agent_type")
OutcomeKind = Literal["acknowledged", "proceed", "rewrite", "refuse", "deliver", "replace", "withhold"]


def read_host_event(stream: Any = None, *, max_bytes: int = MAX_BYTES) -> dict[str, Any]:
    """Read one bounded, strictly decoded host event (stdin by default)."""
    source = sys.stdin.buffer if stream is None else stream
    try:
        raw = source.read(max_bytes + 1)
        if not isinstance(raw, bytes) or len(raw) > max_bytes:
            raise ValueError()
        value = strict_loads(raw)
        if not _object(value):
            raise ValueError()
        return value
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise Unavailable("Host event is not bounded plain JSON") from error


@dataclass(frozen=True)
class Outcome:
    """`kind` is the only field to branch on; `reason` is display text.

    `cause` is set only when the Hook gave no decision: the `Unavailable.code`
    (`hook-identity:<cause>`, `hook-transport` or `hook-protocol`).
    """
    event: str
    boundary: str
    kind: OutcomeKind
    reason: str | None = None
    operator_message: str | None = None
    decision: Decision | None = None
    input: dict[str, Any] | None = None
    output: Any = None
    has_output: bool = False
    cause: str | None = None


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _outcome(event: str, boundary: str, kind: OutcomeKind, *, error: Exception | None = None,
             decision: Decision | None = None, input: dict[str, Any] | None = None,
             output: Any = None, has_output: bool = False) -> Outcome:
    reason = None
    if error is not None:
        reason = f"{error}: {decision.reason}" if decision is not None and decision.reason else str(error)
    # The Hook was never consulted (identity, transport or protocol): name why.
    cause = error.code if isinstance(error, Unavailable) else None
    return Outcome(event, boundary, kind, reason, decision.operator_message if decision else None,
                   decision, input, output, has_output, cause)


def hook_command(client: Client, payload: Any, *, approve: Callable[[str], bool] | None = None,
                 check_version: bool = False, cancel: threading.Event | None = None) -> Outcome:
    """Decide one canonical host event through the shipped Client.

    Lifecycle: `acknowledged` or `refuse`. Pre-action: `proceed` (run the exact
    original input), `rewrite` (run exactly `input`) or `refuse` (do not run).
    Post-action: `deliver` (show the original result), `replace` (show exactly
    `output`) or `withhold`. Transport failure and every refusal are outcomes,
    never allows; a malformed event raises before the Hook runs.
    """
    event = snapshot(payload)
    if not _object(event):
        raise Unavailable("Host event is not bounded plain JSON")
    name = event.get("hook_event_name")
    if not isinstance(name, str) or name not in HOOK_COMMAND_EVENTS:
        raise Refused("Unsupported hook-command event")
    native, boundary = HOOK_COMMAND_EVENTS[name]
    request = {field: event[field] for field in _FORWARDED if field in event}
    # Identity is checked here as well as in the Client so a malformed event is
    # refused before any Hook process starts.
    if not isinstance(request.get("session_id"), str) or not request["session_id"]:
        raise ValueError("A stable native session identity is required")
    if boundary != "lifecycle" and (not isinstance(request.get("tool_use_id"), str) or not request["tool_use_id"]):
        raise ValueError("A stable native tool-call identity is required")
    if boundary == "pre" and not _object(request.get("tool_input")):
        raise ValueError("A pre-action event requires a tool_input object")
    if boundary == "post" and "tool_response" not in request:
        raise ValueError("A post-action event requires tool_response")
    refusal: OutcomeKind = "withhold" if boundary == "post" else "refuse"
    try:
        if check_version:
            client.check_version()
        decision = client.decide(native, request, boundary=boundary, cancel=cancel)
    except (Unavailable, Refused) as error:
        return _outcome(native, boundary, refusal, error=error)
    if boundary == "lifecycle":
        if decision.kind == "allow":
            return _outcome(native, boundary, "acknowledged", decision=decision)
        return _outcome(native, boundary, refusal, decision=decision,
                        error=Refused("Isonapse did not acknowledge this lifecycle event"))
    if boundary == "pre":
        original = request["tool_input"]
        try:
            selected = execute(decision, original, lambda chosen: chosen, approve=approve)
        except (Refused, Unavailable) as error:
            return _outcome(native, boundary, refusal, error=error, decision=decision)
        kind: OutcomeKind = "proceed" if _canonical(selected) == _canonical(original) else "rewrite"
        return _outcome(native, boundary, kind, decision=decision, input=selected)
    original = request["tool_response"]
    try:
        visible = deliver(decision, original)
    except (Refused, Unavailable) as error:
        return _outcome(native, boundary, refusal, error=error, decision=decision)
    kind = "deliver" if _canonical(visible) == _canonical(original) else "replace"
    return _outcome(native, boundary, kind, decision=decision, output=visible, has_output=True)
