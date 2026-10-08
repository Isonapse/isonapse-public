import json
import unittest
from dataclasses import FrozenInstanceError
from isonapse_hook_adk import decode, Refused, Unavailable
from isonapse_hook_adk.runtime import Runtime


class Callbacks(unittest.TestCase):
    def test_native_identity_is_fixed_for_callback_lifetime(self):
        runtime = Runtime(object(), "session", "/repo", lambda _: None)
        with self.assertRaises(FrozenInstanceError): runtime.session_id = "other-session"
        with self.assertRaises(ValueError): Runtime(object(), "session", "/repo", None)
    def test_invalid_input_never_executes_and_invalid_result_marks_completion_unknown(self):
        calls, effects = [], []
        class Client:
            def decide(self, event, request, *, boundary):
                calls.append(event)
                return decode(b'{"protocolVersion":1,"decision":"allow"}', boundary)
        runtime = Runtime(Client(), "session", "/repo", lambda _: None)
        for invalid in [{1:"coerced-key"}, {"x":(1,2)}, {"x":set()}, {"x":float("inf")}]:
            with self.assertRaises(Unavailable):
                runtime.tool("invalid", "Read", invalid, lambda args: effects.append(args))
        self.assertEqual(calls, [])
        self.assertEqual(effects, [])
        for output in [set(), "x" * (1024 * 1024 + 1)]:
            def effect(args): effects.append(args); return output
            with self.assertRaisesRegex(Unavailable, "completion unknown.*do not retry"):
                runtime.tool("output", "Read", {}, effect)
        self.assertEqual(effects, [{}, {}])
        self.assertEqual(calls, ["pre-tool-use", "pre-tool-use"])

    def test_caller_mutation_cannot_change_authorized_input_or_scanned_output(self):
        arguments, output = {"path":"safe"}, {"text":"scanned"}
        class Client:
            def decide(self, event, request, *, boundary):
                if boundary == "pre": arguments["path"] = "changed"
                else: output["text"] = "unscanned"
                return decode(b'{"protocolVersion":1,"decision":"allow"}', boundary)
        runtime = Runtime(Client(), "session", "/repo", lambda _: None)
        effects = []
        def effect(value): effects.append(value); return output
        self.assertEqual(runtime.tool("one", "Read", arguments, effect), {"text":"scanned"})
        self.assertEqual(effects, [{"path":"safe"}])

    def test_exact_effect_input_and_completion_before_visible_output(self):
        calls = []
        class Client:
            def check_version(self): pass
            def decide(self, event, request, *, boundary):
                calls.append((event, request))
                extra = {"effectiveInput": {"path":"safe"}} if boundary == "pre" else {"updatedOutput":"redacted"} if boundary == "post" else {}
                return decode(json.dumps({"protocolVersion":1,"decision":"allow", **extra}).encode(), boundary)
        runtime = Runtime(Client(), "native-session", "/repo", lambda message: None)
        runtime.start()
        effects = []
        def effect(args):
            effects.append(dict(args))
            args["path"] = "callback-local-mutation"
            return "private output"
        self.assertEqual(runtime.tool("call-1", "Read", {"path":"unsafe", "extra":True}, effect), "redacted")
        runtime.end()
        self.assertEqual(effects, [{"path":"safe"}])
        self.assertEqual([event for event, _ in calls], ["session-start", "pre-tool-use", "post-tool-use", "session-end"])
        self.assertEqual(calls[2][1]["tool_input"], {"path":"safe"})
        self.assertEqual(calls[2][1]["tool_use_id"], "call-1")
        self.assertEqual(calls[2][1]["tool_response"], "private output")

    def test_refusal_never_executes_and_failed_completion_never_retries(self):
        calls, effects = [], []
        class Client:
            kind = "deny"
            def decide(self, event, request, *, boundary):
                calls.append(event)
                kind = self.kind if boundary == "pre" else "unavailable"
                extra = {} if kind == "allow" else {"reason":"fixture refusal"}
                if kind == "unavailable": extra["retryable"] = False
                return decode(json.dumps({"protocolVersion":1,"decision":kind, **extra}).encode(), boundary)
        client = Client()
        runtime = Runtime(client, "native-session", "/repo", lambda message: None)
        with self.assertRaises(Refused): runtime.tool("one", "Read", {}, lambda args: effects.append(args))
        self.assertEqual(effects, [])
        self.assertEqual(calls, ["pre-tool-use"])
        client.kind = "allow"
        with self.assertRaises(Refused): runtime.tool("two", "Read", {}, lambda args: effects.append(args))
        self.assertEqual(effects, [{}])
        self.assertEqual(calls, ["pre-tool-use", "pre-tool-use", "post-tool-use"])

if __name__ == "__main__": unittest.main()
