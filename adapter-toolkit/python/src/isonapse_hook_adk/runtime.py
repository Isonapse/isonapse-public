"""Native callback orchestration; never a shell/tool executor."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
from . import Client, Refused, Unavailable, deliver, execute, snapshot


@dataclass(frozen=True)
class Runtime:
    """One trusted native session. The caller supplies real effect callbacks.

    Session/call identity, cwd, and operator UI are host-owned, not model input.
    Do not retry `tool` after a completion failure: the effect already happened.
    """
    client: Client
    session_id: str
    cwd: str
    notify: Callable[[str], None]
    approve: Callable[[str], bool] | None = None

    def __post_init__(self):
        if not self.session_id or not isinstance(self.session_id, str) or not isinstance(self.cwd, str) or not self.cwd or not callable(self.notify):
            raise ValueError("Trusted native session and working directory required")

    def _decide(self, event: str, request: dict[str, Any], boundary: str):
        names = {"session-start":"SessionStart", "session-end":"SessionEnd", "pre-tool-use":"PreToolUse", "post-tool-use":"PostToolUse"}
        decision = self.client.decide(event, {**request, "hook_event_name":names[event], "session_id": self.session_id, "cwd": self.cwd}, boundary=boundary)
        if decision.operator_message:
            self.notify(decision.operator_message)
        return decision

    def start(self):
        self.client.check_version()
        decision = self._decide("session-start", {}, "lifecycle")
        if decision.kind != "allow":
            raise Refused(decision.reason or "Session startup was not allowed")

    def end(self):
        decision = self._decide("session-end", {}, "lifecycle")
        if decision.kind != "allow":
            raise Refused(decision.reason or "Session shutdown was not acknowledged")

    def tool(self, call_id: str, name: str, arguments: dict[str, Any], effect: Callable[[dict[str, Any]], Any]):
        arguments = snapshot(arguments)
        request = {"tool_use_id": call_id, "tool_name": name, "tool_input": arguments}
        decision = self._decide("pre-tool-use", request, "pre")
        def invoke(selected):
            # Retain the exact applied input even if the callback mutates its copy.
            applied = snapshot(selected)
            failed = False
            try:
                output = effect(selected)
            except Exception:
                # Never leak arbitrary exception text or retry the native effect.
                failed = True
                output = {"is_error": True, "error": "Native tool callback failed"}
            try:
                output = snapshot(output)
                completion = self._decide("post-tool-use", {**request, "tool_input": applied, "tool_response": output}, "post")
            except Exception as error:
                raise Unavailable("Native effect already ran; completion unknown. Output withheld; do not retry the effect.") from error
            visible = deliver(completion, output)
            if failed:
                raise Refused("Native tool failed; completion reported")
            return visible
        return execute(decision, arguments, invoke, approve=self.approve)
