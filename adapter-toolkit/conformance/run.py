#!/usr/bin/env python3
"""Standalone Host Adapter Protocol v1 conformance runner (Apache-2.0)."""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

REQUIRED_CASES = (
    "ask-with-native-approval",
    "defer-on-incapable-host",
    "deny-with-output-replacement",
    "deny",
    "garbage-output",
    "hook-crash-fail-closed",
    "hung-hook-fail-closed",
    "key-removal-rewrite",
    "output-rewrite",
    "oversized-output",
    "permit-with-rewrite",
    "protocol-version-mismatch",
    "session-end-lifecycle",
    "stop-lifecycle",
    "unavailable-fail-closed",
)
ALL_CAPABILITIES = {"can_ask", "can_rewrite_input", "can_rewrite_output"}

STUB = r'''#!/usr/bin/env python3
import json, os, sys, time
fixture = json.loads(open(os.environ["ISONAPSE_FIXTURE"], encoding="utf-8").read())
open(os.environ["ISONAPSE_ARGV_LOG"], "w", encoding="utf-8").write(json.dumps(sys.argv[1:]))
open(os.environ["ISONAPSE_REQUEST_LOG"], "wb").write(sys.stdin.buffer.read())
if fixture.get("hookHangSeconds"):
    time.sleep(float(fixture["hookHangSeconds"]))
raw = fixture.get("hookStdoutRaw")
if raw is None:
    body = fixture["hookStdout"]
    target = fixture.get("padReasonToBytes")
    if target:
        body["reason"] += "x" * int(target)
    raw = json.dumps(body, separators=(",", ":"))
sys.stdout.write(raw)
raise SystemExit(int(fixture["hookExit"]))
'''


def load_fixtures(root: Path) -> dict[str, tuple[Path, dict[str, object]]]:
    fixtures: dict[str, tuple[Path, dict[str, object]]] = {}
    for path in sorted(root.glob("*.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("case") != path.stem:
            raise ValueError(f"{path.name}: case must equal filename")
        fixtures[path.stem] = (path, value)
    if tuple(fixtures) != REQUIRED_CASES:
        raise ValueError("fixture topology differs from the frozen Protocol v1 cases")
    return fixtures


def expectation(fixture: dict[str, object], capabilities: set[str]) -> dict[str, object]:
    required = fixture.get("requiresCapability")
    selected = (
        fixture.get("expectWithoutCapability")
        if isinstance(required, str) and required not in capabilities
        else fixture.get("expect")
    )
    if not isinstance(selected, dict):
        raise ValueError(f"{fixture['case']}: malformed expectation")
    return selected


def run_case(
    adapter: Path,
    stub: Path,
    fixture_path: Path,
    fixture: dict[str, object],
    capabilities: set[str],
    expected_host: str,
) -> list[str]:
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="isonapse-adapter-case-") as temporary:
        work = Path(temporary)
        effect = work / "effect.log"
        argv_log = work / "argv.log"
        request_log = work / "request.json"
        environment = os.environ.copy()
        environment.update(
            {
                "ISONAPSE_HOOK_BIN": str(stub),
                "ISONAPSE_FIXTURE": str(fixture_path),
                "ISONAPSE_ARGV_LOG": str(argv_log),
                "ISONAPSE_REQUEST_LOG": str(request_log),
                "ISONAPSE_ADAPTER_EFFECT_LOG": str(effect),
            }
        )
        # Only the deliberately wedged fixture needs the shortened probe. Normal
        # process startup must not inherit its 500 ms budget, even from the caller.
        environment.pop("ISONAPSE_CONFORMANCE_TIMEOUT_MS", None)
        if fixture.get("case") == "hung-hook-fail-closed":
            environment["ISONAPSE_CONFORMANCE_TIMEOUT_MS"] = "500"
        request = json.dumps(fixture["hookRequest"], separators=(",", ":"))
        try:
            command = (
                [sys.executable, str(adapter)]
                if adapter.suffix == ".py"
                else [str(adapter)]
            )
            completed = subprocess.run(
                [*command, str(fixture["event"])],
                input=request,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=environment,
                timeout=4,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return ["adapter exceeded the suite deadline"]
        expected = expectation(fixture, capabilities)
        executed = expected.get("exitStatus") == "executed"
        if (completed.returncode == 0) != executed:
            failures.append(
                f"exit {completed.returncode}, expected {'executed' if executed else 'refused'}"
            )
        observed_effect = effect.read_text(encoding="utf-8") if effect.exists() else ""
        if observed_effect != expected.get("effectLog", ""):
            failures.append(
                f"effect {observed_effect!r}, expected {expected.get('effectLog', '')!r}"
            )
        if completed.stdout != expected.get("modelOutput", ""):
            failures.append(
                f"model output {completed.stdout!r}, "
                f"expected {expected.get('modelOutput', '')!r}"
            )
        diagnostic = expected.get("stderrContains")
        if isinstance(diagnostic, str) and diagnostic not in completed.stderr:
            failures.append(f"stderr omitted {diagnostic!r}")
        if not argv_log.exists():
            failures.append("adapter never invoked the hook")
        else:
            argv = json.loads(argv_log.read_text(encoding="utf-8"))
            try:
                host_index = argv.index("--host")
                protocol_index = argv.index("--adapter-protocol")
                handshake_ok = (
                    argv.count("--host") == 1
                    and argv.count("--adapter-protocol") == 1
                    and argv[host_index + 1] == expected_host
                    and argv[protocol_index + 1] == "1"
                )
            except (ValueError, IndexError):
                handshake_ok = False
            if not handshake_ok:
                failures.append(f"wrong hook handshake: {argv!r}")
        if request_log.exists() and request_log.read_text(encoding="utf-8") != request:
            failures.append("adapter altered the native event before the hook saw it")
    return failures


def run_suite(
    adapter: Path,
    fixtures: dict[str, tuple[Path, dict[str, object]]],
    capabilities: set[str],
    expected_host: str,
) -> dict[str, list[str]]:
    findings: dict[str, list[str]] = {}
    with tempfile.TemporaryDirectory(prefix="isonapse-adapter-stub-") as temporary:
        stub = Path(temporary) / "isonapse-hook"
        stub.write_text(STUB, encoding="utf-8")
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
        for name, (path, fixture) in fixtures.items():
            failures = run_case(adapter, stub, path, fixture, capabilities, expected_host)
            if failures:
                findings[name] = failures
    return findings


def mutation_proof(fixtures: dict[str, tuple[Path, dict[str, object]]]) -> bool:
    scaffold = Path(__file__).parents[1] / "template/adapter.py"
    source = scaffold.read_text(encoding="utf-8")
    needle = 'effective = decision.get("effectiveInput", host_event.get("tool_input"))'
    replacement = 'effective = host_event.get("tool_input")'
    if source.count(needle) != 1:
        raise ValueError(
            "bundled scaffold lacks the seam needed for the anti-theater mutation proof"
        )
    with tempfile.TemporaryDirectory(prefix="isonapse-mutated-adapter-") as temporary:
        mutated = Path(temporary) / "adapter.py"
        mutated.write_text(source.replace(needle, replacement), encoding="utf-8")
        fixture_path, fixture = fixtures["permit-with-rewrite"]
        stub = Path(temporary) / "isonapse-hook"
        stub.write_text(STUB, encoding="utf-8")
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
        findings = run_case(
            mutated,
            stub,
            fixture_path,
            fixture,
            ALL_CAPABILITIES,
            "synthetic",
        )
    return bool(findings)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--expected-host", default="synthetic")
    parser.add_argument(
        "--capability",
        action="append",
        choices=sorted(ALL_CAPABILITIES),
        help="repeat for each capability; omitted means all three",
    )
    parser.add_argument(
        "--no-capabilities",
        action="store_true",
        help="declare none of the three optional host capabilities",
    )
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=Path(__file__).with_name("fixtures"),
    )
    arguments = parser.parse_args()
    adapter = arguments.adapter.resolve()
    if not adapter.is_file():
        parser.error("--adapter must name a regular file")
    try:
        fixtures = load_fixtures(arguments.fixtures)
        if arguments.no_capabilities and arguments.capability:
            parser.error("--no-capabilities cannot be combined with --capability")
        capabilities = (
            set()
            if arguments.no_capabilities
            else set(arguments.capability or ALL_CAPABILITIES)
        )
        findings = run_suite(adapter, fixtures, capabilities, arguments.expected_host)
        if findings:
            for case, failures in findings.items():
                for failure in failures:
                    print(f"FAIL {case}: {failure}", file=sys.stderr)
            return 1
        if not mutation_proof(fixtures):
            print("FAIL anti-theater proof did not catch a dropped rewrite", file=sys.stderr)
            return 1
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"conformance: {error}", file=sys.stderr)
        return 2
    print(f"PASS Protocol v1: {len(fixtures)} fixtures and anti-theater mutation proof")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
