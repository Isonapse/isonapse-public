import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from dataclasses import FrozenInstanceError
from unittest import mock

from isonapse_hook_adk import Client, InstalledHook, Refused, Unavailable, decode
from isonapse_hook_adk.hook_command import HOOK_COMMAND_EVENTS, hook_command, read_host_event


def wire(decision="allow", **fields):
    return json.dumps({"protocolVersion": 1, "decision": decision, **fields}).encode()


# Codex CLI 0.155.1 payload shapes: canonical fields plus host-native extras.
def codex(name, **extra):
    return {"session_id": "thread-1", "cwd": "/work", "hook_event_name": name, "model": "scripted",
            "permission_mode": "bypassPermissions", "transcript_path": None, **extra}


def pre(**extra):
    return {**codex("PreToolUse"), "tool_use_id": "call-1", "tool_name": "Bash",
            "tool_input": {"command": "printf ok"}, "turn_id": "turn-1", **extra}


def post(**extra):
    return {**pre(), "hook_event_name": "PostToolUse", "tool_response": "ok", **extra}


class Fake:
    def __init__(self, respond):
        self.respond, self.calls, self.versions = respond, [], 0

    def check_version(self):
        self.versions += 1

    def decide(self, event, request, *, boundary, cancel=None):
        self.calls.append((event, json.loads(json.dumps(request)), boundary))
        return decode(self.respond(event, request, boundary), boundary)


class HostEvents(unittest.TestCase):
    def test_host_events_are_bounded_strictly_decoded_objects(self):
        self.assertEqual(read_host_event(io.BytesIO(b'{"a":1}')), {"a": 1})
        for bad in [b'{"a":1,"a":2}', b'[]', b'"x"', b'{"a":1', b'{"a":{"b":1,"b":2}}', b'{\xff}',
                    b'{"a":' + b"x" * (1024 * 1024) + b"}"]:
            with self.subTest(bad=bad[:16]), self.assertRaises(Unavailable):
                read_host_event(io.BytesIO(bad))
        with self.assertRaises(Unavailable):
            read_host_event(io.BytesIO(b'{"a":"0123456789"}'), max_bytes=8)
        with self.assertRaises(Unavailable):
            read_host_event(io.StringIO('{"a":1}'))
        self.assertEqual(HOOK_COMMAND_EVENTS["PreToolUse"], ("pre-tool-use", "pre"))


class PreAction(unittest.TestCase):
    def test_proceed_rewrite_and_refuse(self):
        response = [wire()]
        client = Fake(lambda *_: response[0])
        out = hook_command(client, pre())
        self.assertEqual((out.kind, out.input, out.reason), ("proceed", {"command": "printf ok"}, None))
        self.assertEqual(client.calls[-1][0], "pre-tool-use")
        self.assertEqual(client.calls[-1][2], "pre")
        with self.assertRaises(FrozenInstanceError):
            out.kind = "mutated"
        response[0] = wire(effectiveInput={"command": "printf [REDACTED]"})
        out = hook_command(client, pre())
        self.assertEqual((out.kind, out.input), ("rewrite", {"command": "printf [REDACTED]"}))
        # Key order is not a rewrite; a removed key is.
        response[0] = wire(effectiveInput={"b": 2, "a": 1})
        self.assertEqual(hook_command(client, pre(tool_input={"a": 1, "b": 2})).kind, "proceed")
        response[0] = wire(effectiveInput={"a": 1})
        out = hook_command(client, pre(tool_input={"a": 1, "b": 2}))
        self.assertEqual((out.kind, out.input), ("rewrite", {"a": 1}))
        response[0] = wire("deny", reason="policy says no", operatorMessage="operator note")
        out = hook_command(client, pre())
        self.assertEqual(out.kind, "refuse")
        self.assertIn("did not permit", out.reason)
        self.assertIn("policy says no", out.reason)
        self.assertEqual(out.operator_message, "operator note")
        self.assertIsNone(out.input)
        self.assertEqual(out.decision.kind, "deny")
        response[0] = wire("unavailable", reason="daemon down", retryable=True)
        out = hook_command(client, pre())
        self.assertEqual((out.kind, out.decision.retryable), ("refuse", True))
        # `ask` is a refusal unless the host supplies a real approval surface.
        response[0] = wire("ask", reason="review")
        out = hook_command(client, pre())
        self.assertEqual(out.kind, "refuse")
        self.assertIn("approval was not granted", out.reason)
        approvals = []
        out = hook_command(client, pre(), approve=lambda reason: (approvals.append(reason), False)[1])
        self.assertEqual((out.kind, approvals), ("refuse", ["review"]))
        self.assertEqual(hook_command(client, pre(), approve=lambda _: True).kind, "proceed")
        response[0] = wire("ask", reason="review", effectiveInput={"command": "approved"})
        out = hook_command(client, pre(), approve=lambda _: True)
        self.assertEqual((out.kind, out.input), ("rewrite", {"command": "approved"}))


class PostAction(unittest.TestCase):
    def test_deliver_replace_and_withhold(self):
        response = [wire()]
        client = Fake(lambda *_: response[0])
        out = hook_command(client, post())
        self.assertEqual((out.kind, out.output, out.has_output), ("deliver", "ok", True))
        self.assertEqual(client.calls[-1][2], "post")
        response[0] = wire(updatedOutput="[PII]")
        out = hook_command(client, post())
        self.assertEqual((out.kind, out.output), ("replace", "[PII]"))
        response[0] = wire("deny", reason="mask", updatedOutput=None)
        out = hook_command(client, post())
        self.assertEqual((out.kind, out.output, out.has_output), ("replace", None, True))
        response[0] = wire("deny", reason="block")
        out = hook_command(client, post())
        self.assertEqual((out.kind, out.has_output), ("withhold", False))
        self.assertIn("withheld", out.reason)
        self.assertIn("block", out.reason)
        response[0] = wire("unavailable", reason="gone", retryable=False)
        self.assertEqual(hook_command(client, post()).kind, "withhold")
        response[0] = wire()
        self.assertEqual(hook_command(client, post(tool_response={"b": 1, "a": [1, 2]})).kind, "deliver")


class Lifecycle(unittest.TestCase):
    def test_acknowledged_or_refused_and_version_check_on_request(self):
        response = [wire()]
        client = Fake(lambda *_: response[0])
        out = hook_command(client, codex("SessionStart", source="startup"), check_version=True)
        self.assertEqual((out.kind, client.versions), ("acknowledged", 1))
        self.assertEqual(client.calls[-1][:1] + client.calls[-1][2:], ("session-start", "lifecycle"))
        out = hook_command(client, codex("SessionEnd", reason="other"))
        self.assertEqual((out.kind, client.versions, client.calls[-1][0]), ("acknowledged", 1, "session-end"))
        response[0] = wire("deny", reason="session refused", operatorMessage="warn")
        out = hook_command(client, codex("SessionStart"))
        self.assertEqual((out.kind, out.operator_message), ("refuse", "warn"))
        self.assertIn("session refused", out.reason)
        response[0] = wire(operatorMessage="failed to bind session identity")
        out = hook_command(client, codex("SessionStart", source="resume"))
        self.assertEqual((out.kind, out.operator_message), ("acknowledged", "failed to bind session identity"))


class Failures(unittest.TestCase):
    def test_transport_failure_is_a_refusal_at_every_boundary(self):
        class Down:
            def check_version(self): pass
            def decide(self, *a, **k): raise Unavailable("Hook transport failed")
        self.assertEqual(hook_command(Down(), pre()).kind, "refuse")
        self.assertEqual(hook_command(Down(), post()).kind, "withhold")
        life = hook_command(Down(), codex("SessionStart", source="startup"))
        self.assertEqual((life.kind, life.decision), ("refuse", None))
        self.assertIn("transport failed", life.reason)
        decided = []
        class Incompatible:
            def check_version(self): raise Unavailable("incompatible")
            def decide(self, *a, **k): decided.append(a)
        self.assertEqual(hook_command(Incompatible(), codex("SessionStart"), check_version=True).kind, "refuse")
        self.assertEqual(decided, [])
        class Broken:
            def decide(self, *a, **k): raise TypeError("host bug")
        with self.assertRaises(TypeError):
            hook_command(Broken(), pre())

    def test_unsupported_or_malformed_events_never_reach_the_hook(self):
        client = Fake(lambda *_: wire())
        for bad, error in [(codex("Stop"), Refused), (codex("UserPromptSubmit", prompt="x"), Refused),
                           ({**pre(), "hook_event_name": 42}, Refused), ("not an object", Unavailable),
                           ([pre()], Unavailable), (pre(tool_input={"x": float("inf")}), Unavailable),
                           ({k: v for k, v in pre().items() if k != "tool_use_id"}, ValueError),
                           (pre(tool_use_id=""), ValueError), (pre(tool_input="printf"), ValueError),
                           (pre(tool_input=["printf"]), ValueError),
                           ({k: v for k, v in post().items() if k != "tool_response"}, ValueError),
                           ({k: v for k, v in pre().items() if k != "session_id"}, ValueError),
                           (codex("SessionStart", session_id=""), ValueError)]:
            with self.subTest(bad=bad), self.assertRaises(error):
                hook_command(client, bad)
        self.assertEqual((client.calls, client.versions), ([], 0))

    def test_only_canonical_fields_reach_the_hook_and_outcome_is_a_snapshot(self):
        client = Fake(lambda *_: wire())
        payload = pre(prompt="ignored", expansion_type="skill", transcript_path="/tmp/t.jsonl",
                      agent_id="sub-1", agent_type="explorer", extra={"deep": True})
        out = hook_command(client, payload)
        sent = client.calls[0][1]
        self.assertEqual(sorted(sent), ["agent_id", "agent_type", "cwd", "hook_event_name", "session_id",
                                        "tool_input", "tool_name", "tool_use_id"])
        self.assertEqual((sent["hook_event_name"], sent["agent_id"]), ("PreToolUse", "sub-1"))
        payload["tool_input"]["command"] = "changed after the decision"
        self.assertEqual(out.input, {"command": "printf ok"})


@unittest.skipUnless(os.name == "posix", "ADK v1 process transport is Unix-only")
class Transport(unittest.TestCase):
    def fixture(self, source):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name).resolve() / "isonapse-hook"
        data = f"#!{sys.executable}\n{source}".encode()
        path.write_bytes(data)
        path.chmod(0o700)
        return Client(InstalledHook(path, hashlib.sha256(data).hexdigest()), "adk-codex-test", timeout=10)

    def test_helper_drives_the_shipped_transport(self):
        client = self.fixture(
            "import json,sys\n"
            "argv=sys.argv[1:]\n"
            "if argv[1:]!=['--host','adk-codex-test','--adapter-protocol','1']: sys.exit(9)\n"
            "e=json.load(sys.stdin)\n"
            "if argv[0]=='pre-tool-use':\n"
            "    denied='curl' in e['tool_input']['command']\n"
            "    print(json.dumps({'protocolVersion':1,'decision':'deny' if denied else 'allow',**({'reason':'fixture denial'} if denied else {'effectiveInput':{'command':e['tool_input']['command']+' --safe'}})}))\n"
            "elif argv[0]=='post-tool-use': print(json.dumps({'protocolVersion':1,'decision':'deny','reason':'fixture withhold'}))\n"
            "else: print(json.dumps({'protocolVersion':1,'decision':'allow','operatorMessage':'event '+argv[0]+' '+e['hook_event_name']}))\n")
        started = hook_command(client, codex("SessionStart", source="startup"))
        self.assertEqual((started.kind, started.operator_message), ("acknowledged", "event session-start SessionStart"))
        rewrite = hook_command(client, pre())
        self.assertEqual((rewrite.kind, rewrite.input), ("rewrite", {"command": "printf ok --safe"}))
        deny = hook_command(client, pre(tool_input={"command": "curl x"}))
        self.assertEqual(deny.kind, "refuse")
        self.assertIn("fixture denial", deny.reason)
        self.assertEqual(hook_command(client, post()).kind, "withhold")
        crash = self.fixture("import sys; sys.exit(9)")
        self.assertEqual(hook_command(crash, pre()).kind, "refuse")
        self.assertEqual(hook_command(crash, post()).kind, "withhold")
        self.assertEqual(hook_command(crash, codex("SessionEnd", reason="other")).kind, "refuse")


# #929 messaging: an outcome names `cause` exactly when the Hook gave no
# decision, so an adapter can tell an identity, transport or protocol refusal
# (never fixed by retrying) from a Hook decision. One negative per class.
@unittest.skipUnless(os.name == "posix", "ADK v1 process transport is Unix-only")
class Causes(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="isonapse-adk-cause-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()

    def hook(self, name, source, mode=0o700, parent=None):
        path = (parent or self.root) / name
        data = f"#!{sys.executable}\n{source}".encode()
        path.write_bytes(data)
        path.chmod(mode)
        return path, hashlib.sha256(data).hexdigest()

    @staticmethod
    def answer(value):
        return f"import sys\nsys.stdin.read()\nprint({value.decode()!r})\n"

    @staticmethod
    def client(path, pin):
        return Client(InstalledHook(path, pin), "adk-codex-test", timeout=5)

    def test_refusals_without_a_hook_decision_carry_their_cause(self):
        P = "Installed Hook identity could not be verified"
        allow, allow_pin = self.hook("allow", self.answer(wire()))
        world = self.root / "world"
        world.mkdir()
        world.chmod(0o777)
        exposed, exposed_pin = self.hook("exposed", self.answer(wire()), parent=world)
        crash, crash_pin = self.hook("crash", "raise SystemExit(9)")
        garbage, garbage_pin = self.hook("garbage", self.answer(b"not json"))
        refusals = [
            ("pin mismatch", self.client(allow, "0" * 64), "hook-identity:pin-mismatch",
             f"{P} (pin mismatch): the Hook binary does not match the configured SHA-256 pin. After an Isonapse upgrade, recompute the pin from hook_binary_path, update the hook definition and re-trust it."),
            ("untrusted path", self.client(exposed, exposed_pin), "hook-identity:untrusted-path",
             f"{P} (untrusted path): a directory on the Hook path is world-writable and not a root-owned sticky directory."),
            ("missing Hook", self.client(self.root / "absent", allow_pin), "hook-identity:missing",
             f"{P} (Hook missing): nothing exists at the configured Hook path; check hook_binary_path in the Isonapse configuration."),
            ("invalid configuration", self.client(Path("relative/isonapse-hook"), allow_pin), "hook-identity:invalid-configuration",
             f"{P} (invalid configuration): the Hook path must be absolute and the pin must be 64 lowercase hexadecimal characters."),
            ("transport", self.client(crash, crash_pin), "hook-transport", "Hook did not return a successful protocol response"),
            ("protocol", self.client(garbage, garbage_pin), "hook-protocol", "Invalid or incompatible Hook Protocol v1 response"),
        ]
        for label, subject, cause, reason in refusals:
            for payload, kind in ((pre(), "refuse"), (post(), "withhold"), (codex("SessionEnd", reason="other"), "refuse")):
                with self.subTest(label=label, event=payload["hook_event_name"]):
                    out = hook_command(subject, payload)
                    self.assertEqual((out.kind, out.cause, out.reason, out.decision), (kind, cause, reason, None))
        # changed: the Hook file is replaced (same bytes) between the walk and the open.
        swapped, swapped_pin = self.hook("swapped", self.answer(wire()))
        real = os.open

        def opener(target, *args, **kwargs):
            if os.fsdecode(target) == str(swapped):
                self.hook("swapped.new", self.answer(wire()))
                os.rename(str(swapped) + ".new", swapped)
            return real(target, *args, **kwargs)
        with mock.patch("os.open", side_effect=opener):
            changed = hook_command(self.client(swapped, swapped_pin), pre())
        self.assertEqual((changed.kind, changed.cause, changed.reason),
                         ("refuse", "hook-identity:changed",
                          f"{P} (changed during verification): the Hook path or file changed while it was being verified, for example during an upgrade."))
        # The version probe is a protocol check too.
        old, old_pin = self.hook("old", 'print("isonapse-hook 0.2.9")')
        probed = hook_command(self.client(old, old_pin), codex("SessionStart", source="startup"), check_version=True)
        self.assertEqual((probed.kind, probed.cause, probed.reason),
                         ("refuse", "hook-protocol", "Installed Hook version is incompatible with ADK v1"))
        # Every Hook decision that refuses keeps its decision and has no cause.
        for label, response in (("deny", wire("deny", reason="policy says no")),
                                ("ask without approval", wire("ask", reason="review")),
                                ("unavailable decision", wire("unavailable", reason="control-plane-unavailable", retryable=True))):
            path, pin = self.hook(f"decided-{label.replace(' ', '-')}", self.answer(response))
            out = hook_command(self.client(path, pin), pre())
            self.assertEqual((out.kind, out.cause, out.decision.kind), ("refuse", None, json.loads(response)["decision"]), label)
        fine = hook_command(self.client(allow, allow_pin), pre())
        self.assertEqual((fine.kind, fine.cause), ("proceed", None))


if __name__ == "__main__":
    unittest.main()
