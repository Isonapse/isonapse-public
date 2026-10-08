#!/usr/bin/env python3
"""Minimal Host Adapter Protocol v1 scaffold (Apache-2.0)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from typing import BinaryIO, NoReturn

HOST_ID = "synthetic"  # Replace after the profile is accepted upstream.
MAX_RESPONSE = 1024 * 1024
HOOK_TIMEOUT_SECONDS = 55.0
CONFORMANCE_TIMEOUT_SECONDS = 0.5


def refuse(message: str) -> NoReturn:
    print(f"isonapse adapter: {message}", file=sys.stderr)
    raise SystemExit(2)


def read_bounded(stream: BinaryIO, result: list[object]) -> None:
    try:
        result.append(stream.read(MAX_RESPONSE + 1))
    except BaseException as error:
        result.append(error)


def write_input(stream: BinaryIO, payload: bytes, result: list[object]) -> None:
    try:
        stream.write(payload)
        stream.flush()
        stream.close()
        result.append(None)
    except BaseException as error:
        result.append(error)


def kill_and_reap(process: subprocess.Popen[bytes]) -> None:
    try:
        process.kill()
    except OSError:
        pass
    try:
        process.wait(timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        pass


def decide(event: str, request: bytes) -> dict[str, object]:
    hook = os.environ.get("ISONAPSE_HOOK_BIN")
    if not hook:
        refuse("ISONAPSE_HOOK_BIN is unset")
    try:
        process = subprocess.Popen(
            [hook, event, "--host", HOST_ID, "--adapter-protocol", "1"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        refuse("hook could not be started; no decision exists")
    assert process.stdin is not None and process.stdout is not None
    written: list[object] = []
    response: list[object] = []
    workers = [
        threading.Thread(
            target=write_input,
            args=(process.stdin, request, written),
            daemon=True,
        ),
        threading.Thread(
            target=read_bounded,
            args=(process.stdout, response),
            daemon=True,
        ),
    ]
    for worker in workers:
        worker.start()
    # The public suite needs to prove a wedged-hook refusal without waiting for
    # the production deadline. Its isolated stub supplies all four sentinels;
    # the seam only shortens the deadline and cannot make a decision permissive.
    conformance_stub = (
        os.environ.get("ISONAPSE_CONFORMANCE_TIMEOUT_MS") == "500"
        and all(
            os.environ.get(name)
            for name in (
                "ISONAPSE_FIXTURE",
                "ISONAPSE_ARGV_LOG",
                "ISONAPSE_REQUEST_LOG",
                "ISONAPSE_ADAPTER_EFFECT_LOG",
            )
        )
    )
    timeout = CONFORMANCE_TIMEOUT_SECONDS if conformance_stub else HOOK_TIMEOUT_SECONDS
    deadline = time.monotonic() + timeout
    while True:
        if response and isinstance(response[0], bytes) and len(response[0]) > MAX_RESPONSE:
            kill_and_reap(process)
            refuse("hook answer exceeded the 1 MiB protocol ceiling")
        if process.poll() is not None and written and response:
            break
        if time.monotonic() >= deadline:
            kill_and_reap(process)
            refuse("hook deadline; it was killed and no decision exists")
        time.sleep(0.005)
    if process.returncode != 0:
        refuse("hook failed; no decision exists")
    if isinstance(written[0], BaseException):
        refuse("host event could not be sent to the hook")
    if isinstance(response[0], BaseException):
        refuse("hook answer could not be read")
    raw = response[0]
    assert isinstance(raw, bytes)
    if len(raw) > MAX_RESPONSE:
        refuse("hook answer exceeded the 1 MiB protocol ceiling")
    try:
        decoded = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        refuse("hook answer is not Protocol v1 JSON")
    if not isinstance(decoded, dict) or decoded.get("protocolVersion") != 1:
        refuse("hook protocol version mismatch")
    if decoded.get("decision") not in {"allow", "deny", "ask", "unavailable"}:
        refuse("hook decision is unknown")
    return decoded


def render(value: object) -> str:
    return value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))


def apply_decision(event: str, host_event: dict[str, object], decision: dict[str, object]) -> None:
    kind = decision["decision"]
    if kind in {"deny", "unavailable"}:
        if event in {"PostToolUse", "tool_result"} and "updatedOutput" in decision:
            print(render(decision["updatedOutput"]), end="")
            return
        refuse(str(decision.get("reason", "action refused")))
    if kind == "ask":
        # The synthetic test host models affirmative native approval. A real
        # adapter must call its declared approval UI and refuse on any failure.
        pass
    if event in {"PostToolUse", "tool_result"}:
        output = decision.get("updatedOutput", host_event.get("tool_response"))
        if output is None:
            refuse("post-action event has no result")
        print(render(output), end="")
        return
    if event in {"stop", "session-end"}:
        return
    effective = decision.get("effectiveInput", host_event.get("tool_input"))
    if not isinstance(effective, dict) or not isinstance(effective.get("command"), str):
        refuse("authorized effective input has no command")
    completed = subprocess.run(["sh", "-c", effective["command"]], check=False)
    if completed.returncode != 0:
        refuse("authorized command failed")


def main() -> None:
    if len(sys.argv) != 2:
        refuse("usage: adapter.py EVENT")
    request = sys.stdin.buffer.read(MAX_RESPONSE + 1)
    if len(request) > MAX_RESPONSE:
        refuse("host event exceeded the 1 MiB ceiling")
    try:
        host_event = json.loads(request)
    except (UnicodeDecodeError, json.JSONDecodeError):
        refuse("host event is not JSON")
    if not isinstance(host_event, dict):
        refuse("host event is not an object")
    apply_decision(sys.argv[1], host_event, decide(sys.argv[1], request))


if __name__ == "__main__":
    main()
