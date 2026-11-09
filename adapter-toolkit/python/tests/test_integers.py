"""The same raw JSON integer vectors as the TypeScript ADK and Codex adapter."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

from isonapse_hook_adk import Client, InstalledHook, Unavailable, decode, snapshot
from isonapse_hook_adk.hook_command import hook_command, read_host_event

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "conformance/vectors/json-integers.json").read_text())


def event(value):
    return ('{"hook_event_name":"PreToolUse","session_id":"integers","cwd":"/work",'
            '"tool_use_id":"call","tool_name":"mcp__example__update","tool_input":' + value + '}').encode()


def answer(effective):
    return '{"protocolVersion":1,"decision":"allow"' + (
        '' if effective is None else ',"effectiveInput":' + effective) + '}'


class IntegerTests(unittest.TestCase):
    def fixture(self, response):
        temporary = tempfile.TemporaryDirectory(prefix="isonapse-adk-integers-")
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name).resolve()
        request = directory / "request.json"
        path = directory / "hook"
        # No parser touches either wire: the captured request is the exact
        # Client serialization, and the canned answer retains its raw numbers.
        data = (f'#!{sys.executable}\nimport sys\nfrom pathlib import Path\n'
                f'Path({str(request)!r}).write_bytes(sys.stdin.buffer.read())\n'
                f'sys.stdout.write({response!r})\n').encode()
        path.write_bytes(data)
        path.chmod(0o700)
        return Client(InstalledHook(path, hashlib.sha256(data).hexdigest()), "codex"), request

    def test_shared_vectors_forward_and_select_the_exact_integers(self):
        for row in VECTORS["accepted"]:
            with self.subTest(row=row["name"]):
                client, request = self.fixture(answer(row["effective"]))
                payload = read_host_event(io.BytesIO(event(row["input"])))
                outcome = hook_command(client, payload)
                self.assertEqual(outcome.kind, row["kind"])
                self.assertIn('"tool_input":' + row["input"], request.read_text())
                self.assertEqual(json.dumps(outcome.input, separators=(",", ":")), row["effective"] or row["input"])
                self.assertEqual(json.dumps(snapshot(payload["tool_input"]), separators=(",", ":")), row["input"])
                if row["name"] == "odd-integer":
                    self.assertEqual(payload["tool_input"]["account_id"], 9007199254740993)
                    self.assertIs(type(payload["tool_input"]["account_id"]), int)

    def test_shared_unrepresentable_values_refuse_at_both_boundaries(self):
        for row in VECTORS["refused"]:
            with self.subTest(row=row["name"]):
                value = '{"account_id":' + row["value"] + '}'
                with self.assertRaises(Unavailable):
                    read_host_event(io.BytesIO(event(value)))
                with self.assertRaises(Unavailable) as error:
                    decode(answer(value).encode(), "pre")
                self.assertEqual(error.exception.code, "hook-protocol")
                client, _ = self.fixture(answer(value))
                outcome = hook_command(client, read_host_event(io.BytesIO(event('{"account_id":1}'))))
                self.assertEqual(outcome.kind, "refuse")
                self.assertEqual(outcome.cause, "hook-protocol")
                self.assertIsNone(outcome.input)

    def test_out_of_range_native_integers_refuse_before_the_hook_runs(self):
        for number in [1 << 64, -(1 << 63) - 1]:
            with self.subTest(number=number):
                client, request = self.fixture(answer(None))
                with self.assertRaises(Unavailable):
                    client.decide("pre-tool-use", {"session_id":"s", "tool_use_id":"c", "tool_input":{"id":number}}, boundary="pre")
                self.assertFalse(request.exists())
                with self.assertRaises(Unavailable):
                    snapshot({"id":number})


if __name__ == "__main__":
    unittest.main()
