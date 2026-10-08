"""Hermes pre-action governance with opportunistic result observation."""

from __future__ import annotations

import json
import logging
import subprocess
import threading
import time
from pathlib import Path
from typing import Any
from ._adk_json import loads as strict_json_loads

SAFE_RESULT = "Isonapse withheld this tool result because governance did not return a usable decision."
MAX_ADAPTER_OUTPUT_BYTES = 1024 * 1024
MAX_ADAPTER_INPUT_BYTES = 1024 * 1024
MAX_ADAPTER_STDERR_BYTES = 64 * 1024
ADAPTER_TIMEOUT_SECONDS = 55.0

logger = logging.getLogger("isonapse.hermes")


def _working_directory() -> str | None:
    try:
        return str(Path.cwd())
    except OSError:
        return None


def _render(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))


def _adapter_bin() -> str:
    try:
        installed = Path(__file__).with_name("adapter-path").read_text().strip()
    except OSError as error:
        raise FileNotFoundError(
            "Isonapse's cohort-bound Hermes adapter path is missing; reinstall Isonapse"
        ) from error
    adapter = Path(installed)
    if not installed or not adapter.is_absolute():
        raise ValueError(
            "Isonapse's Hermes adapter path is not an absolute installed-cohort path"
        )
    return str(adapter)


def _read_bounded(stream: Any, ceiling: int, result: list[Any]) -> None:
    try:
        result.append(stream.read(ceiling + 1))
    except BaseException as error:
        result.append(error)


def _write_input(stream: Any, payload: bytes, result: list[Any]) -> None:
    try:
        stream.write(payload)
        stream.flush()
        stream.close()
        result.append(None)
    except BaseException as error:
        result.append(error)


def _kill_and_reap(process: subprocess.Popen[bytes]) -> None:
    try:
        process.kill()
    except BaseException:
        pass
    try:
        process.wait(timeout=1)
    except BaseException:
        pass


def _run_adapter(event: str, payload: dict[str, Any]) -> subprocess.CompletedProcess[str]:
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_ADAPTER_INPUT_BYTES:
        raise ValueError("Hermes event exceeded the adapter protocol ceiling")

    process = subprocess.Popen(
        [_adapter_bin(), event],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    written: list[Any] = []
    stdout: list[Any] = []
    stderr: list[Any] = []
    workers = [
        threading.Thread(target=_write_input, args=(process.stdin, encoded, written), daemon=True),
        threading.Thread(
            target=_read_bounded,
            args=(process.stdout, MAX_ADAPTER_OUTPUT_BYTES, stdout),
            daemon=True,
        ),
        threading.Thread(
            target=_read_bounded,
            args=(process.stderr, MAX_ADAPTER_STDERR_BYTES, stderr),
            daemon=True,
        ),
    ]
    for worker in workers:
        worker.start()

    deadline = time.monotonic() + ADAPTER_TIMEOUT_SECONDS
    while True:
        if stdout and isinstance(stdout[0], bytes) and len(stdout[0]) > MAX_ADAPTER_OUTPUT_BYTES:
            _kill_and_reap(process)
            raise ValueError("adapter instruction exceeded the protocol ceiling")
        if stderr and isinstance(stderr[0], bytes) and len(stderr[0]) > MAX_ADAPTER_STDERR_BYTES:
            _kill_and_reap(process)
            raise ValueError("adapter diagnostic exceeded its bounded ceiling")
        if process.poll() is not None and written and stdout and stderr:
            break
        if time.monotonic() >= deadline:
            _kill_and_reap(process)
            raise subprocess.TimeoutExpired([_adapter_bin(), event], ADAPTER_TIMEOUT_SECONDS)
        time.sleep(0.005)

    for value in [written[0], stdout[0], stderr[0]]:
        if isinstance(value, BaseException):
            raise value
    return subprocess.CompletedProcess(
        process.args,
        process.returncode,
        stdout[0].decode("utf-8"),
        stderr[0].decode("utf-8"),
    )


def _required_identity(
    tool_name: str, args: Any, session_id: str, tool_call_id: str
) -> None:
    if not isinstance(tool_name, str) or not tool_name:
        raise ValueError("Hermes callback omitted tool_name")
    if not isinstance(args, dict):
        raise ValueError("Hermes callback args are not an object")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("Hermes callback omitted its stable session_id")
    if not isinstance(tool_call_id, str) or not tool_call_id:
        raise ValueError("Hermes callback omitted its tool_call_id")


def _governance_identity(session_id: str) -> tuple[str, str | None]:
    # Hermes delegation is blocked in supported enforcement mode. Treat every
    # accepted callback as top-level; never guess a child/parent attribution.
    return session_id, None


def _pre_tool_call(
    tool_name: str = "",
    args: Any = None,
    session_id: str = "",
    tool_call_id: str = "",
    **_: Any,
) -> dict[str, str] | None:
    _required_identity(tool_name, args, session_id, tool_call_id)
    governance_session_id, agent_id = _governance_identity(session_id)
    payload = {
        "session_id": governance_session_id,
        "hook_event_name": "pre_tool_call",
        "cwd": _working_directory(),
        "tool_name": tool_name,
        "tool_use_id": tool_call_id,
        "tool_input": args,
    }
    if agent_id is not None:
        payload["agent_id"] = agent_id
    completed = _run_adapter("pre_tool_call", payload)
    instruction = strict_json_loads(completed.stdout)
    if not isinstance(instruction, dict):
        raise ValueError("adapter instruction is not an object")
    if completed.returncode == 0:
        if not set(instruction).issubset({"warning"}):
            raise ValueError("Hermes pre-action allow carried an unknown instruction")
        warning = instruction.get("warning")
        if warning is not None:
            if not isinstance(warning, str) or not warning:
                raise ValueError("adapter warning is not a non-empty string")
            logger.warning("isonapse: %s", warning)
        return None
    if (
        set(instruction) == {"action", "message"}
        and instruction.get("action") == "block"
        and isinstance(instruction.get("message"), str)
        and instruction["message"]
    ):
        return instruction
    raise RuntimeError(completed.stderr.strip() or f"adapter exited {completed.returncode}")


def pre_tool_call(**kwargs: Any) -> dict[str, str] | None:
    try:
        decision = _pre_tool_call(**kwargs)
        if decision is not None:
            return decision
        # The pinned Hermes runtime creates child agents only through this
        # agent-level tool, whose nested identity/result path does not traverse
        # the audited top-level transform seam. Refuse that one unsupported
        # surface rather than inventing parent/child attribution.
        if kwargs.get("tool_name") in {"delegate_task", "execute_code"}:
            return {
                "action": "block",
                "message": "isonapse: nested Hermes execution is unsupported under governance",
            }
        return None
    except BaseException as error:
        try:
            logger.error("isonapse blocked a Hermes tool call: %s", error)
        except BaseException:
            pass
        return {
            "action": "block",
            "message": "isonapse: governance did not return a usable authorization",
        }


def _transform_tool_result(
    tool_name: str = "",
    args: Any = None,
    result: Any = "",
    session_id: str = "",
    tool_call_id: str = "",
    **_: Any,
) -> str:
    _required_identity(tool_name, args, session_id, tool_call_id)
    governance_session_id, agent_id = _governance_identity(session_id)
    payload = {
        "session_id": governance_session_id,
        "hook_event_name": "transform_tool_result",
        "cwd": _working_directory(),
        "tool_name": tool_name,
        "tool_use_id": tool_call_id,
        "tool_input": args,
        "tool_response": result,
    }
    if agent_id is not None:
        payload["agent_id"] = agent_id
    completed = _run_adapter("transform_tool_result", payload)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"adapter exited {completed.returncode}")
    if len(completed.stdout.encode("utf-8")) > MAX_ADAPTER_OUTPUT_BYTES:
        raise ValueError("adapter instruction exceeded the protocol ceiling")
    instruction = strict_json_loads(completed.stdout)
    if not isinstance(instruction, dict):
        raise ValueError("adapter instruction is not an object")
    if not set(instruction).issubset({"output", "warning"}):
        raise ValueError("adapter instruction has an unknown shape")
    warning = instruction.get("warning")
    if warning is not None:
        if not isinstance(warning, str) or not warning:
            raise ValueError("adapter warning is not a non-empty string")
        logger.warning("isonapse: %s", warning)
    if "output" not in instruction:
        return _render(result)
    if not isinstance(instruction["output"], str):
        raise ValueError("adapter output is not a string")
    return instruction["output"]


def transform_tool_result(**kwargs: Any) -> str:
    try:
        return _transform_tool_result(**kwargs)
    except BaseException as error:
        try:
            logger.error("isonapse withheld a Hermes tool result: %s", error)
        except BaseException:
            pass
        return SAFE_RESULT


def _lifecycle(event: str, session_id: str) -> None:
    if not isinstance(session_id, str) or not session_id:
        raise ValueError(f"Hermes {event} callback omitted session_id")
    completed = _run_adapter(
        event,
        {
            "session_id": session_id,
            "hook_event_name": event,
            "cwd": _working_directory(),
        },
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"adapter exited {completed.returncode}")
    instruction = strict_json_loads(completed.stdout)
    if not isinstance(instruction, dict) or not set(instruction).issubset({"warning"}):
        raise ValueError(f"Hermes {event} instruction has an unknown shape")
    warning = instruction.get("warning")
    if warning is not None:
        if not isinstance(warning, str) or not warning:
            raise ValueError("adapter warning is not a non-empty string")
        logger.warning("isonapse: %s", warning)


def _lifecycle_callback(event: str, session_id: str = "", **_: Any) -> None:
    try:
        _lifecycle(event, session_id)
    except BaseException as error:
        try:
            logger.error("isonapse could not witness Hermes %s: %s", event, error)
        except BaseException:
            pass


def on_session_start(**kwargs: Any) -> None:
    _lifecycle_callback("on_session_start", **kwargs)


def on_session_end(**kwargs: Any) -> None:
    _lifecycle_callback("on_session_end", **kwargs)


def on_session_finalize(**kwargs: Any) -> None:
    _lifecycle_callback("on_session_finalize", **kwargs)


def _register_priority_hooks(ctx: Any) -> None:
    """Bind audited v0.20 callbacks first in the current registry.

    Hermes selects the first pre-tool directive and first result-transform
    string. Public registration appends, so merely enabling this plugin is not
    a governance guarantee. The supported, pinned runtime exposes the owning
    manager and its hook lists on PluginContext; refuse plugin load if that
    exact structure changes, then put our callbacks at index zero. Supported
    init/status separately require Isonapse to be the sole enabled plugin;
    changing that registry afterward is outside the verified profile.
    """
    manager = getattr(ctx, "_manager", None)
    hooks = getattr(manager, "_hooks", None)
    register_hook = getattr(ctx, "register_hook", None)
    if not isinstance(hooks, dict) or not callable(register_hook):
        raise RuntimeError(
            "unsupported Hermes plugin-hook registry; Isonapse precedence cannot be proven"
        )
    registrations = [
        ("pre_tool_call", pre_tool_call),
        ("transform_tool_result", transform_tool_result),
        ("on_session_start", on_session_start),
        ("on_session_end", on_session_end),
        ("on_session_finalize", on_session_finalize),
    ]
    prior = {event: list(hooks.get(event, [])) for event, _ in registrations}
    existed = {event: event in hooks for event, _ in registrations}
    try:
        for event, callback in registrations:
            register_hook(event, callback)
            callbacks = hooks.get(event)
            if not isinstance(callbacks, list) or sum(item is callback for item in callbacks) != 1:
                raise RuntimeError(f"Hermes did not register Isonapse's {event} callback exactly once")
            callbacks[:] = [callback] + [item for item in callbacks if item is not callback]
            if not callbacks or callbacks[0] is not callback:
                raise RuntimeError(f"Isonapse could not establish first priority for {event}")
    except BaseException:
        for event, _ in registrations:
            if existed[event]:
                hooks[event] = prior[event]
            else:
                hooks.pop(event, None)
        raise


def register(ctx: Any) -> None:
    _register_priority_hooks(ctx)
