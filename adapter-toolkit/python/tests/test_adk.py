import errno
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import time
import signal
import unittest
from unittest import mock

from isonapse_hook_adk import Client, InstalledHook, Unavailable, Refused, decode, execute, deliver


class ProtocolTests(unittest.TestCase):
    def test_decisions_are_single_use_and_rewrites_are_immutable_snapshots(self):
        from isonapse_hook_adk import Decision
        decision = decode(self.decision("ask", reason="review", effectiveInput={"path":"safe"}), "pre")
        decision.effective_input["path"] = "changed"
        effects = []
        execute(decision, {}, effects.append, approve=lambda _: True)
        self.assertEqual(effects, [{"path":"safe"}])
        with self.assertRaises(Refused): execute(decision, {}, effects.append, approve=lambda _: True)
        with self.assertRaises(Refused): execute(Decision("allow", _boundary="pre"), {}, effects.append)
        original = {"path":"safe"}
        def approve(_):
            original["path"] = "changed"
            return True
        execute(decode(self.decision("ask", reason="review"), "pre"), original, effects.append, approve=approve)
        self.assertEqual(effects[-1], {"path":"safe"})

    def decision(self, kind="allow", **fields):
        return json.dumps(dict(protocolVersion=1, decision=kind, **fields)).encode()

    def test_exact_rewrite_and_refusal_change_real_callback_effects(self):
        effects = []
        allowed = decode(self.decision(effectiveInput={"path":"approved", "removed":None}), "pre")
        execute(allowed, {"path":"original","secret":"must disappear"}, effects.append)
        self.assertEqual(effects, [{"path":"approved","removed":None}])
        for kind, fields in [("deny", {}), ("unavailable", {"retryable":True}), ("ask", {})]:
            refused = decode(self.decision(kind, reason="operator review", **fields), "pre")
            with self.assertRaises(Refused):
                execute(refused, {}, effects.append)
        self.assertEqual(len(effects), 1)
        ask = decode(self.decision("ask", reason="review", effectiveInput={"approved":True}), "pre")
        execute(ask, {}, effects.append, approve=lambda _: True)
        self.assertEqual(effects[-1], {"approved":True})

    def test_output_replacement_and_withholding(self):
        decision = decode(self.decision("deny", reason="redacted", updatedOutput=None), "post")
        self.assertIsNone(deliver(decision, "private"))
        with self.assertRaises(Refused):
            deliver(decode(self.decision("deny",reason="blocked"), "post"), "private")
        for boundary in ("lifecycle", "post"):
            with self.assertRaises(Refused):
                execute(decode(self.decision(), boundary), {}, lambda _: self.fail("wrong boundary executed"))
        with self.assertRaises(Refused):
            deliver(decode(self.decision(), "pre"), "private")

    def test_malformed_known_fields_never_authorize(self):
        values = [b'{"decision":"deny","decision":"allow","protocolVersion":1}',
                  b'{"protocolVersion":1,"decision":"allow","effectiveInput":{"a":1,"a":2}}',
                  self.decision(protocol_version=1)[:-1], b'[]', b'\xff',
                  self.decision("allow", reason="no"), self.decision("deny"),
                  self.decision("unavailable",reason="missing retry"),
                  self.decision(effectiveInput=[]), self.decision(retryable="false"),
                  b'{"protocolVersion":true,"decision":"allow"}',
                  b'{"protocolVersion":2,"decision":"allow"}',
                  self.decision(updatedOutput="wrong boundary")]
        for value in values:
            with self.subTest(value=value), self.assertRaises(Unavailable):
                decode(value,"pre")
        self.assertEqual(decode(self.decision(extension={"arbitrary":"data"}),"pre").kind,"allow")


@unittest.skipUnless(os.name == "posix", "ADK v1 process transport is Unix-only")
class TransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name).resolve()/"isonapse-hook"

    def client(self, source, timeout=2):
        # Deliberately pinned protocol fixture, not a shipped executor.
        self.path.write_text(f"#!{sys.executable}\n"+source)
        self.path.chmod(0o700)
        return Client(InstalledHook(self.path,hashlib.sha256(self.path.read_bytes()).hexdigest()), "pi", timeout=timeout)

    def call(self, client, **options):
        return client.decide("tool_call", {"session_id":"session","tool_use_id":"call"}, boundary="pre", **options)

    def test_real_transport_and_version(self):
        client = self.client('import sys,json\nif "--version" in sys.argv: print("isonapse-hook 0.3.0-beta+test.abc")\nelse:\n value=json.load(sys.stdin)\n assert value["tool_use_id"]=="call"\n print(json.dumps({"protocolVersion":1,"decision":"allow"}))\n')
        self.assertIn("0.3.0",client.check_version())
        self.assertEqual(self.call(client).kind,"allow")

    def test_crash_hang_overflow_and_cancellation_refuse(self):
        for source in ['raise SystemExit(9)', 'import time; time.sleep(30)',
                       'print("x"*(1024*1024+1))', 'import sys; sys.stderr.write("x"*70000)']:
            client=self.client(source,timeout=0.2)
            with self.subTest(source=source), self.assertRaises(Unavailable): self.call(client)
        cancelled=threading.Event(); cancelled.set()
        client=self.client('raise RuntimeError("must not start")')
        with self.assertRaises(Unavailable) as raised: self.call(client,cancel=cancelled)
        self.assertEqual(raised.exception.code, "hook-transport")

    def test_pin_permissions_and_symlink_are_enforced(self):
        # #929: each refusal names its cause; none reaches the Hook process.
        client=self.client('print("fixture")')
        self.path.write_text('changed')
        with self.assertRaises(Unavailable) as raised: self.call(client)
        self.assertEqual((raised.exception.code, str(raised.exception)),
                         ("hook-identity:pin-mismatch", IDENTITY_TEXT["pin-mismatch"]))
        client=self.client('print("fixture")'); self.path.chmod(0o722)
        with self.assertRaises(Unavailable) as raised: self.call(client)
        self.assertEqual((raised.exception.code, str(raised.exception)),
                         ("hook-identity:untrusted-path", untrusted_text("file")))
        # #929 changed the contract: a link the caller owns, in a directory
        # that passes, is followed, and verify() returns the real target.
        client=self.client('print("fixture")')
        link=self.path.with_name("link"); link.symlink_to(self.path)
        self.assertEqual(InstalledHook(link,client.installed.sha256).verify(), self.path)
        # A str path is accepted, and a refusal is Unavailable, not AttributeError.
        self.assertEqual(InstalledHook(str(link),client.installed.sha256).verify(), self.path)
        with self.assertRaises(Unavailable) as raised: InstalledHook(str(link),"0"*64).verify()
        self.assertEqual(raised.exception.code, "hook-identity:pin-mismatch")

    def test_escaped_pipe_holder_does_not_leak_transport_threads(self):
        marker = self.path.with_name("holder-pid")
        source = ('import os,time\n'
                  'if os.fork()==0:\n'
                  ' os.setsid()\n'
                  f' open({str(marker)!r},"w").write(str(os.getpid()))\n'
                  ' time.sleep(30)\n'
                  'else: time.sleep(30)\n')
        client = self.client(source, timeout=5)
        cancel = threading.Event()
        results = []
        def invoke():
            try:
                self.call(client, cancel=cancel)
            except BaseException as error:
                results.append(error)
        before = set(threading.enumerate())
        worker = threading.Thread(target=invoke, daemon=True)
        worker.start()
        pid = None
        try:
            deadline = time.monotonic()+5
            while time.monotonic()<deadline:
                if marker.exists() and marker.read_text():
                    pid = int(marker.read_text())
                    break
                cancel.wait(0.01)
            self.assertIsNotNone(pid, "escaped pipe holder must actually start")
            cancel.set()
            worker.join(timeout=3)
            self.assertFalse(worker.is_alive(), "cancellation must not wait for escaped pipes")
            self.assertEqual(len(results), 1)
            self.assertIsInstance(results[0], Unavailable)
            self.assertEqual(set(threading.enumerate()), before)
            os.kill(pid, 0)
        finally:
            cancel.set()
            if pid:
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass


# ---------------------------------------------------------------------------
# #929: the installed-Hook trust rule (option A). The same case names and
# expected causes are pinned in typescript/tests/adk.test.js.
# ---------------------------------------------------------------------------
IDENTITY = "Installed Hook identity could not be verified"
RULES = {
    "owner": "an entry on the Hook path is not owned by you or root",
    "world-writable": "a directory on the Hook path is world-writable and not a root-owned sticky directory",
    "group-writable": "a directory on the Hook path is group-writable by a group other than macOS admin or your private Linux group",
    "links": "the Hook path has more than 8 symbolic links",
    "not-a-directory": "a component of the Hook path is not a directory",
    "file": "the Hook is not a regular file of at most 1 GiB owned by you or root and writable only by its owner",
}
IDENTITY_TEXT = {
    "pin-mismatch": f"{IDENTITY} (pin mismatch): the Hook binary does not match the configured SHA-256 pin. After an Isonapse upgrade, recompute the pin from hook_binary_path, update the hook definition and re-trust it.",
    "missing": f"{IDENTITY} (Hook missing): nothing exists at the configured Hook path; check hook_binary_path in the Isonapse configuration.",
    "changed": f"{IDENTITY} (changed during verification): the Hook path or file changed while it was being verified, for example during an upgrade.",
    "invalid-configuration": f"{IDENTITY} (invalid configuration): the Hook path must be absolute and the pin must be 64 lowercase hexadecimal characters.",
}


# The pin-file causes (pinned identically in typescript/tests/adk.test.js).
PIN_FIX = "Run isonapse hook adk-pin and use the pin file it names."
PIN_RULES = {
    "owner": "an entry on the pin file path is not owned by you or root",
    "world-writable": "a directory on the pin file path is world-writable and not a root-owned sticky directory",
    "group-writable": "a directory on the pin file path is group-writable by a group other than macOS admin or your private Linux group",
    "links": "the pin file path has more than 8 symbolic links",
    "not-a-directory": "a component of the pin file path is not a directory",
    "file": "the pin file is not a regular file owned by you or root and writable only by its owner",
}
IDENTITY_TEXT["pin-file-missing"] = f"{IDENTITY} (pin file missing): nothing exists at the configured pin file path. {PIN_FIX}"
IDENTITY_TEXT["pin-file-invalid"] = f"{IDENTITY} (pin file invalid): the pin file path must be absolute and the file must hold exactly one SHA-256 as 64 lowercase hexadecimal characters. {PIN_FIX}"
PIN_FILE_MISMATCH = f"{IDENTITY} (pin mismatch): the Hook binary does not match the SHA-256 in the pin file. After an Isonapse upgrade, run isonapse hook adk-pin; the hook definition does not change."


def untrusted_text(rule):
    return f"{IDENTITY} (untrusted path): {RULES[rule]}."


def expected(outcome):
    """"ok" or a cause; "untrusted-path:<rule>" and "pin-file-untrusted:<rule>"
    name the rule text as well; "pin-file-mismatch" is the pin-mismatch code
    with the pin-file text."""
    if outcome.startswith("untrusted-path:"):
        return {"code": "hook-identity:untrusted-path", "message": untrusted_text(outcome[15:])}
    if outcome.startswith("pin-file-untrusted:"):
        return {"code": "hook-identity:pin-file-untrusted",
                "message": f"{IDENTITY} (pin file untrusted): {PIN_RULES[outcome[19:]]}. {PIN_FIX}"}
    if outcome == "pin-file-mismatch":
        return {"code": "hook-identity:pin-mismatch", "message": PIN_FILE_MISMATCH}
    return {"code": f"hook-identity:{outcome}", "message": IDENTITY_TEXT[outcome]}


def verdict(path, pin, installed=None):
    try:
        return {"ok": str((installed or InstalledHook(path, pin)).verify())}
    except Unavailable as error:
        return {"code": error.code, "message": str(error)}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def hook_source(marker):
    return (f"#!{sys.executable}\nimport json,sys\nsys.stdin.read()\n"
            f"print(json.dumps({{'protocolVersion':1,'decision':'deny','reason':{marker!r}+' ran as '+sys.argv[0]}}))\n").encode()


GENUINE, IMPOSTOR = hook_source("genuine"), hook_source("impostor")
UID = os.geteuid() if os.name == "posix" else -1
GROUPS = os.getgroups() if os.name == "posix" else []
# The one group the rule trusts, when the caller can actually use it here.
TRUSTED_GROUP = ((80 if 80 in GROUPS else None) if sys.platform == "darwin"
                 else (UID if sys.platform.startswith("linux") and os.getegid() == UID else None))
# A group the caller can chgrp to that the rule must refuse.
OTHER_GROUP = next((group for group in GROUPS if group not in (80, TRUSTED_GROUP)), None)


class Forged:
    """Real lstat results with some fields changed (an injected owner/group)."""
    FIELDS = ("st_mode", "st_ino", "st_dev", "st_nlink", "st_uid", "st_gid", "st_size", "st_mtime_ns")

    def __init__(self, real, **fields):
        for name in self.FIELDS:
            setattr(self, name, getattr(real, name))
        for name, value in fields.items():
            setattr(self, name, value)


@unittest.skipUnless(os.name == "posix", "ADK v1 process transport is Unix-only")
class TrustRuleTests(unittest.TestCase):
    def scratch(self):
        directory = tempfile.TemporaryDirectory(prefix="isonapse-adk-verify-")
        self.addCleanup(directory.cleanup)
        return os.path.realpath(directory.name)

    @staticmethod
    def directory(path, mode=0o755, group=None):
        os.makedirs(path, exist_ok=True)
        if group is not None:
            os.chown(path, -1, group)
        os.chmod(path, mode)

    @staticmethod
    def file(path, data, mode=0o555):
        with open(path, "wb") as output:
            output.write(data)
        os.chmod(path, mode)

    def homebrew(self, group=None, data=GENUINE):
        """bin/ and opt/ links into a Cellar keg whose file is 0555; bin/, opt/
        and Cellar/ take `group` with mode 0775 when given."""
        base = self.scratch()
        prefix = os.path.join(base, "hb")
        self.directory(prefix)
        for name in ("bin", "opt", "Cellar"):
            self.directory(os.path.join(prefix, name), 0o755 if group is None else 0o775, group)
        for name in ("Cellar/isonapse", "Cellar/isonapse/1.0", "Cellar/isonapse/1.0/bin"):
            self.directory(os.path.join(prefix, name))
        hook = os.path.join(prefix, "Cellar/isonapse/1.0/bin/isonapse-hook")
        self.file(hook, data)
        link = os.path.join(prefix, "bin/isonapse-hook")
        os.symlink("../Cellar/isonapse/1.0/bin/isonapse-hook", link)
        os.symlink("../Cellar/isonapse/1.0", os.path.join(prefix, "opt/isonapse"))
        return dict(base=base, prefix=prefix, hook=hook, link=link,
                    opt=os.path.join(prefix, "opt/isonapse/bin/isonapse-hook"), pin=sha(data))

    def assert_verdict(self, label, path, pin, outcome, ok_path=None):
        got = verdict(path, pin)
        self.assertEqual(got, {"ok": ok_path} if outcome == "ok" else expected(outcome), label)

    def assert_pin_verdict(self, label, path, pin_file, outcome, ok_path=None):
        """The same, with the pin read from a pin file."""
        got = verdict(path, None, InstalledHook.from_pin_file(path, pin_file))
        self.assertEqual(got, {"ok": ok_path} if outcome == "ok" else expected(outcome), label)

    @staticmethod
    def spellings(L):
        # Resolved exactly alike by both packages (split on "/", drop "" and
        # ".", resolve ".." against the real directory reached).
        return [
            ("bin link (the recorded Homebrew hook_binary_path)", L["link"], "ok"),
            ("keg path", L["hook"], "ok"),
            ("opt link ancestor", L["opt"], "ok"),
            ("doubled slashes and dots", "/" + L["prefix"] + "//bin/./isonapse-hook", "ok"),
            ("dot-dot after a real directory", f"{L['prefix']}/Cellar/../bin/isonapse-hook", "ok"),
            ("dot-dot above the root", f"/../..{L['link']}", "ok"),
            ("dot-dot through a link is physical, not lexical", f"{L['prefix']}/opt/isonapse/../1.0/bin/isonapse-hook", "ok"),
            ("trailing dot-dot names a directory", f"{L['prefix']}/bin/..", "untrusted-path:file"),
            ("the root itself", "/", "untrusted-path:file"),
            ("a missing entry", f"{L['prefix']}/bin/absent", "missing"),
            ("a regular file used as a directory", f"{L['hook']}/isonapse-hook", "untrusted-path:not-a-directory"),
        ]

    def forge_lstat(self, path, fired, **fields):
        real = os.lstat

        def lstat(target, *args, **kwargs):
            result = real(target, *args, **kwargs)
            if os.fsdecode(target) != path:
                return result
            fired.append(path)
            return Forged(result, **fields)
        return mock.patch("os.lstat", side_effect=lstat)

    def on_open(self, path, action):
        real = os.open

        def opener(target, *args, **kwargs):
            if os.fsdecode(target) == path:
                action()
            return real(target, *args, **kwargs)
        return mock.patch("os.open", side_effect=opener)

    def test_homebrew_layout_links_are_followed_and_verify_returns_the_keg(self):
        L = self.homebrew()
        for label, path, outcome in self.spellings(L):
            self.assert_verdict(label, path, L["pin"], outcome, L["hook"])
        self.assert_verdict("wrong SHA through the link", L["link"], "0" * 64, "pin-mismatch")
        self.assertEqual(InstalledHook(Path(L["link"]), L["pin"]).verify(), Path(L["hook"]))
        # Test for the test: the accepted path really is a link, the keg is 0555.
        self.assertTrue(os.path.islink(L["link"]))
        self.assertEqual(stat.S_IMODE(os.lstat(L["hook"]).st_mode), 0o555)

    def test_trusted_writer_group_accepted_any_other_group_refused(self):
        if TRUSTED_GROUP is not None:
            L = self.homebrew(group=TRUSTED_GROUP)
            cellar = os.lstat(os.path.join(L["prefix"], "Cellar"))
            self.assertEqual((stat.S_IMODE(cellar.st_mode), cellar.st_gid), (0o775, TRUSTED_GROUP))
            for path in (L["link"], L["opt"], L["hook"]):
                self.assert_verdict(f"trusted group {TRUSTED_GROUP}: {path}", path, L["pin"], "ok", L["hook"])
        else:
            # Linux whose primary group is not a private group (gid != uid), or
            # a Mac account outside admin: the same layout must be refused.
            group = os.getegid() if sys.platform.startswith("linux") else OTHER_GROUP
            self.assertIsNotNone(group, "a group-writable fixture needs a group the caller can use")
            L = self.homebrew(group=group)
            self.assertEqual(os.lstat(os.path.join(L["prefix"], "bin")).st_gid, group)
            self.assert_verdict(f"group {group} without the private-group condition", L["link"], L["pin"],
                                "untrusted-path:group-writable")
        L = self.homebrew()
        if OTHER_GROUP is not None:
            for name in ("bin", "Cellar"):
                self.directory(os.path.join(L["prefix"], name), 0o775, OTHER_GROUP)
                self.assertEqual(os.lstat(os.path.join(L["prefix"], name)).st_gid, OTHER_GROUP)
                self.assert_verdict(f"{name} writable by group {OTHER_GROUP}", L["link"], L["pin"],
                                    "untrusted-path:group-writable")
                self.directory(os.path.join(L["prefix"], name), 0o755)
        else:
            # INJECTED: no second group exists for this account.
            fired = []
            with self.forge_lstat(os.path.join(L["prefix"], "Cellar"), fired, st_mode=0o40775, st_gid=4242):
                self.assert_verdict("Cellar writable by an unrelated group (injected)", L["link"], L["pin"],
                                    "untrusted-path:group-writable")
            self.assertTrue(fired, "the injected lstat result was used")
        self.assert_verdict("restored layout", L["link"], L["pin"], "ok", L["hook"])

    def test_world_writable_sticky_and_foreign_owned_ancestry_is_refused(self):
        base = self.scratch()
        self.directory(os.path.join(base, "ww"), 0o777)
        self.file(os.path.join(base, "ww/isonapse-hook"), GENUINE)
        self.assert_verdict("world-writable non-sticky directory", os.path.join(base, "ww/isonapse-hook"),
                            sha(GENUINE), "untrusted-path:world-writable")
        self.directory(os.path.join(base, "sticky"), 0o1777)
        self.file(os.path.join(base, "sticky/isonapse-hook"), GENUINE)
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(base, "sticky")).st_mode), 0o1777)
        self.assert_verdict("user-owned sticky directory", os.path.join(base, "sticky/isonapse-hook"),
                            sha(GENUINE), "untrusted-path:world-writable")
        self.directory(os.path.join(base, "good"))
        os.symlink(os.path.join(base, "ww/isonapse-hook"), os.path.join(base, "good/into-ww"))
        self.assert_verdict("owned link into a world-writable directory", os.path.join(base, "good/into-ww"),
                            sha(GENUINE), "untrusted-path:world-writable")
        L = self.homebrew()
        # INJECTED ownership: a nonroot test cannot create another user's inode.
        for label, path, outcome in (
            ("link owned by another user", L["link"], "untrusted-path:owner"),
            ("directory owned by another user", os.path.join(L["prefix"], "Cellar"), "untrusted-path:owner"),
            ("Hook owned by another user", L["hook"], "untrusted-path:file"),
            ("root-owned link is followed", L["link"], "ok"),
            ("root-owned Hook is accepted", L["hook"], "ok"),
        ):
            fired = []
            owner = 0 if label.startswith("root-owned") else UID + 4242
            with self.forge_lstat(path, fired, st_uid=owner):
                self.assert_verdict(label, L["link"], L["pin"], outcome, L["hook"])
            self.assertTrue(fired, f"{label}: the injected lstat result was used")
        self.assert_verdict("same layout without injection", L["link"], L["pin"], "ok", L["hook"])

    def test_links_hop_limit_loops_dangling_and_non_utf8_targets(self):
        L = self.homebrew()

        def chain(length, name):
            target = L["hook"]
            for index in range(length):
                link = os.path.join(L["base"], f"{name}-{index}")
                os.symlink(target, link)
                target = link
            return target
        self.assert_verdict("8 links (the limit)", chain(8, "eight"), L["pin"], "ok", L["hook"])
        self.assert_verdict("9 links", chain(9, "nine"), L["pin"], "untrusted-path:links")
        os.symlink(os.path.join(L["base"], "loop-b"), os.path.join(L["base"], "loop-a"))
        os.symlink(os.path.join(L["base"], "loop-a"), os.path.join(L["base"], "loop-b"))
        self.assert_verdict("link loop", os.path.join(L["base"], "loop-a"), L["pin"], "untrusted-path:links")
        os.symlink(os.path.join(L["base"], "absent"), os.path.join(L["base"], "dangling"))
        self.assert_verdict("dangling link", os.path.join(L["base"], "dangling"), L["pin"], "missing")
        # A target that is not UTF-8 is refused identically in both packages;
        # the decoy is what a lossy decoder would reach ("t\xff" -> "t�").
        raw = os.path.join(L["base"], "non-utf8")
        os.symlink(b"t\xff/h", os.fsencode(raw))
        self.directory(os.path.join(L["base"], "t�"))
        self.file(os.path.join(L["base"], "t�/h"), GENUINE)
        self.assertEqual(os.readlink(os.fsencode(raw)), b"t\xff/h", "fixture: raw target bytes")
        decoy = os.path.join(L["base"], "t�/h")
        self.assert_verdict("decoy reached directly", decoy, L["pin"], "ok", decoy)
        self.assert_verdict("non-UTF-8 link target", raw, L["pin"], "missing")
        # A valid UTF-8 target that starts with a BOM names the BOM path, as
        # the kernel resolves it: a decoder that strips the BOM would reach "x/h".
        bom = os.path.join(L["base"], "bom-link")
        os.symlink(b"\xef\xbb\xbfx/h", os.fsencode(bom))
        self.directory(os.path.join(L["base"], "﻿x"))
        self.file(os.path.join(L["base"], "﻿x/h"), GENUINE)
        self.assertEqual(os.readlink(os.fsencode(bom))[:3], b"\xef\xbb\xbf", "fixture: the target starts with a BOM")
        self.assertEqual(os.path.realpath(bom), os.path.join(L["base"], "﻿x/h"),
                         "fixture: the kernel resolves the BOM path")
        self.assert_verdict("BOM target, only the BOM path exists", bom, L["pin"], "ok",
                            os.path.join(L["base"], "﻿x/h"))
        self.directory(os.path.join(L["base"], "x"))
        self.file(os.path.join(L["base"], "x/h"), GENUINE)
        self.assert_verdict("BOM target beside a pinned decoy without the BOM", bom, L["pin"], "ok",
                            os.path.join(L["base"], "﻿x/h"))

    def test_root_directory_itself_must_pass_the_directory_rule(self):
        # INJECTED: a real "/" is root 0755, so its lstat result is forged.
        L = self.homebrew()
        for label, fields, outcome in (
            ("world-writable non-sticky root", dict(st_mode=0o40777, st_uid=0), "untrusted-path:world-writable"),
            ("root owned by another user", dict(st_uid=UID + 4242), "untrusted-path:owner"),
            ("root group-writable by an untrusted group", dict(st_mode=0o40775, st_uid=0, st_gid=4242),
             "untrusted-path:group-writable"),
            ("root-owned sticky 1777 root is tolerated", dict(st_mode=0o41777, st_uid=0), "ok"),
        ):
            fired = []
            with self.forge_lstat("/", fired, **fields):
                self.assert_verdict(label, L["link"], L["pin"], outcome, L["hook"])
            self.assertTrue(fired, f'{label}: the injected lstat("/") result was used')
        self.assert_verdict("the real root", L["link"], L["pin"], "ok", L["hook"])

    def test_fifo_swapped_in_before_the_open_is_refused_before_any_read(self):
        # No writer: without O_NONBLOCK the open itself would block.
        L = self.homebrew()

        def to_fifo():
            os.unlink(L["hook"])
            os.mkfifo(L["hook"])
        with self.on_open(L["hook"], to_fifo):
            self.assert_verdict("FIFO without a writer", L["link"], L["pin"], "changed")
        self.assertTrue(stat.S_ISFIFO(os.lstat(L["hook"]).st_mode), "the swap happened")
        # A live writer holding buffered bytes: a read would fail EAGAIN
        # ("missing"), so "changed" proves the inode is checked before reading.
        L = self.homebrew()
        writers = []
        real_open = os.open

        def to_fed_fifo():
            to_fifo()
            writers.append(real_open(L["hook"], os.O_RDWR | os.O_NONBLOCK))
            os.write(writers[0], b"0123456789")
        try:
            with self.on_open(L["hook"], lambda: None if writers else to_fed_fifo()):
                self.assert_verdict("FIFO with a live writer", L["link"], L["pin"], "changed")
            self.assertEqual(len(writers), 1, "the swap happened")
        finally:
            for writer in writers:
                os.close(writer)

    def test_hook_touched_in_place_after_the_walk_is_refused(self):
        # dev and ino are unchanged, so only the size/mtime binding sees it.
        L = self.homebrew()
        inode = os.lstat(L["hook"]).st_ino
        with self.on_open(L["hook"], lambda: os.utime(L["hook"], (1, 1))):
            self.assert_verdict("mtime changed between lstat and hashing", L["link"], L["pin"], "changed")
        after = os.lstat(L["hook"])
        self.assertEqual((after.st_ino, after.st_mtime), (inode, 1), "the touch happened on the same inode")
        self.assert_verdict("the touched Hook verifies on the next event", L["link"], L["pin"], "ok", L["hook"])

    def test_per_platform_writer_group_rule_simulated(self):
        uid = UID
        cases = [
            # (label, platform, egid, Cellar (uid, gid, mode), outcome)
            ("Linux private group", "linux", uid, (uid, uid, 0o40775), "ok"),
            ("Linux group != uid (shared)", "linux", uid, (uid, uid + 1, 0o40775), "untrusted-path:group-writable"),
            ("Linux root-owned, user's group", "linux", uid, (0, uid, 0o40775), "untrusted-path:group-writable"),
            ("Linux egid != uid", "linux", uid + 1, (uid, uid, 0o40775), "untrusted-path:group-writable"),
            ("Linux gid 80 is not special", "linux", uid, (uid, 80, 0o40775), "untrusted-path:group-writable"),
            ("Linux world-writable private", "linux", uid, (uid, uid, 0o40777), "untrusted-path:world-writable"),
            ("root-owned sticky 1777", "linux", uid, (0, 0, 0o41777), "ok"),
            ("macOS root:admin 0775", "darwin", uid, (0, 80, 0o40775), "ok"),
            ("macOS user:admin 0775", "darwin", uid, (uid, 80, 0o40775), "ok"),
            ("macOS user:admin 0777", "darwin", uid, (uid, 80, 0o40777), "untrusted-path:world-writable"),
            ("macOS staff", "darwin", uid, (uid, 20, 0o40775), "untrusted-path:group-writable"),
            ("macOS wheel", "darwin", uid, (uid, 0, 0o40775), "untrusted-path:group-writable"),
            ("macOS another user's admin dir", "darwin", uid, (uid + 1, 80, 0o40775), "untrusted-path:owner"),
            ("macOS private-group shape", "darwin", uid, (uid, uid, 0o40775),
             "ok" if uid == 80 else "untrusted-path:group-writable"),
            ("other platform", "freebsd", uid, (uid, uid, 0o40775), "untrusted-path:group-writable"),
        ]
        L = self.homebrew()
        cellar = os.path.join(L["prefix"], "Cellar")
        platform = sys.platform
        for label, simulated, egid, (owner, group, mode), outcome in cases:
            fired = []
            with mock.patch.object(sys, "platform", simulated), \
                    mock.patch("os.getegid", return_value=egid), \
                    self.forge_lstat(cellar, fired, st_uid=owner, st_gid=group, st_mode=mode):
                self.assert_verdict(label, L["link"], L["pin"], outcome, L["hook"])
            self.assertTrue(fired, f"{label}: the forged Cellar was examined")
        self.assertEqual(sys.platform, platform)

    def test_leaf_rule_and_configuration_checks(self):
        base = self.scratch()
        for mode, label in ((0o575, "group-writable Hook"), (0o557, "world-writable Hook")):
            path = os.path.join(base, f"hook-{mode:o}")
            self.file(path, GENUINE, mode)
            self.assert_verdict(label, path, sha(GENUINE), "untrusted-path:file")
        self.directory(os.path.join(base, "leaf-dir"))
        self.assert_verdict("directory as the Hook", os.path.join(base, "leaf-dir"), sha(GENUINE), "untrusted-path:file")
        large = os.path.join(base, "large")
        with open(large, "wb") as output:
            output.truncate(1024 * 1024 * 1024 + 1)
        os.chmod(large, 0o555)
        self.assert_verdict("Hook over 1 GiB", large, sha(GENUINE), "untrusted-path:file")
        L = self.homebrew()
        for label, path, pin in (
            ("relative path", "hb/bin/isonapse-hook", L["pin"]),
            ("uppercase pin", L["link"], L["pin"].upper()),
            ("short pin", L["link"], L["pin"][1:]),
            ("NUL in the path", L["link"] + "\0x", L["pin"]),
            ("path that is not well-formed Unicode", L["prefix"] + "/\ud800", L["pin"]),
            ("path that is not a string", 42, L["pin"]),
            ("pin that is not a string", L["link"], None),
            ("bytes path", os.fsencode(L["link"]), L["pin"]),
        ):
            self.assert_verdict(label, path, pin, "invalid-configuration")

    def test_hard_link_planted_in_bin_and_the_upgrade_cycle(self):
        L = self.homebrew()
        other = os.path.join(L["base"], "owned-other")
        self.file(other, IMPOSTOR, 0o755)
        os.unlink(L["link"]); os.link(other, L["link"])
        self.assertEqual(os.lstat(L["link"]).st_ino, os.lstat(other).st_ino, "fixture: bin/ holds a hard link")
        self.assert_verdict("hard link to other bytes", L["link"], L["pin"], "pin-mismatch")
        os.unlink(L["link"]); os.link(L["hook"], L["link"])
        self.assert_verdict("hard link to the pinned bytes gains nothing", L["link"], L["pin"], "ok", L["link"])
        # brew upgrade: the link moves to a new keg with new bytes; the pin is stale.
        os.unlink(L["link"])
        self.directory(os.path.join(L["prefix"], "Cellar/isonapse/2.0/bin"))
        new = os.path.join(L["prefix"], "Cellar/isonapse/2.0/bin/isonapse-hook")
        self.file(new, IMPOSTOR)
        self.assert_verdict("mid-upgrade, link absent", L["link"], L["pin"], "missing")
        os.symlink("../Cellar/isonapse/2.0/bin/isonapse-hook", L["link"])
        self.assert_verdict("after upgrade, stale pin, same path", L["link"], L["pin"], "pin-mismatch")
        self.assert_verdict("after upgrade, re-pinned", L["link"], sha(IMPOSTOR), "ok", new)

    def test_races_inside_verify_are_detected(self):
        # I1: the bin link is retargeted after the walk, before the open. The
        # new target holds the SAME bytes, so only the re-resolve can see it.
        L = self.homebrew()
        self.directory(os.path.join(L["prefix"], "Cellar/isonapse/2.0/bin"))
        self.file(os.path.join(L["prefix"], "Cellar/isonapse/2.0/bin/isonapse-hook"), GENUINE)

        def retarget():
            os.unlink(L["link"])
            os.symlink("../Cellar/isonapse/2.0/bin/isonapse-hook", L["link"])
        with self.on_open(L["hook"], retarget):
            self.assert_verdict("link retargeted after resolve", L["link"], L["pin"], "changed")
        self.assertEqual(os.readlink(L["link"]), "../Cellar/isonapse/2.0/bin/isonapse-hook", "the swap happened")
        # I2: the file is renamed over between lstat and open (same bytes again).
        L = self.homebrew()
        before = os.lstat(L["hook"]).st_ino

        def replace():
            self.file(L["hook"] + ".new", GENUINE)
            os.rename(L["hook"] + ".new", L["hook"])
        with self.on_open(L["hook"], replace):
            self.assert_verdict("file replaced between lstat and open", L["link"], L["pin"], "changed")
        self.assertNotEqual(os.lstat(L["hook"]).st_ino, before, "the replacement happened")
        # I4/I5: the file vanishes, or becomes a link, between the walk and the open.
        for label, swap in (
            ("file removed before the open", lambda L: os.unlink(L["hook"])),
            ("file replaced by a link before the open",
             lambda L: (os.rename(L["hook"], L["hook"] + ".real"), os.symlink(L["hook"] + ".real", L["hook"]))),
        ):
            L = self.homebrew()
            with self.on_open(L["hook"], lambda: swap(L)):
                self.assert_verdict(label, L["link"], L["pin"], "changed")
        self.assertTrue(os.path.islink(L["hook"]), "the last swap happened")
        # I3: the keg directory is swapped for a link once hashing is done.
        L = self.homebrew()
        keg = os.path.join(L["prefix"], "Cellar/isonapse/1.0")
        real = os.lstat
        seen = []

        def lstat(target, *args, **kwargs):
            if os.fsdecode(target) == keg:
                seen.append(target)
                if len(seen) == 2:
                    os.rename(keg, keg + ".old")
                    self.directory(os.path.join(L["prefix"], "Cellar/isonapse/evil/bin"))
                    self.file(os.path.join(L["prefix"], "Cellar/isonapse/evil/bin/isonapse-hook"), GENUINE)
                    os.symlink("evil", keg)
            return real(target, *args, **kwargs)
        with mock.patch("os.lstat", side_effect=lstat):
            self.assert_verdict("keg swapped after hashing", L["link"], L["pin"], "changed")
        self.assertEqual(os.readlink(keg), "evil", "the swap happened")
        # I6: the link disappears once hashing is done (mid-upgrade): the
        # second walk fails, and that is reported as a change, not as missing.
        L = self.homebrew()
        walks = []

        def vanish(target, *args, **kwargs):
            if os.fsdecode(target) == L["link"]:
                walks.append(target)
                if len(walks) == 2:
                    os.unlink(L["link"])
            return real(target, *args, **kwargs)
        with mock.patch("os.lstat", side_effect=vanish):
            self.assert_verdict("link removed after hashing", L["link"], L["pin"], "changed")
        self.assertEqual(len(walks), 2, "the second walk reached the link")
        self.assert_verdict("the next event finds nothing", L["link"], L["pin"], "missing")

    def test_client_executes_the_verified_real_path_never_the_link(self):
        def run(L, on_spawn=None):
            client = Client(InstalledHook(L["link"], L["pin"]), "pi", timeout=5)
            request = {"session_id": "session", "tool_use_id": "call"}
            if on_spawn is None:
                return client.decide("tool_call", request, boundary="pre")
            real = subprocess.Popen

            def popen(argv, *args, **kwargs):
                on_spawn(argv[0])
                return real(argv, *args, **kwargs)
            with mock.patch("subprocess.Popen", side_effect=popen):
                return client.decide("tool_call", request, boundary="pre")
        L = self.homebrew()
        self.assertEqual(run(L).reason, f"genuine ran as {L['hook']}")
        # Test for the test: executing the link itself reports the link.
        direct = subprocess.run([L["link"]], input=b"", capture_output=True, timeout=30)
        self.assertIn(f"genuine ran as {L['link']}", direct.stdout.decode())
        # Handled: a bin/ link swapped after verify() cannot change what runs.
        L = self.homebrew()
        impostor = os.path.join(L["base"], "impostor")
        self.file(impostor, IMPOSTOR, 0o755)
        spawned = []

        def swap_link(executable):
            spawned.append(executable)
            os.unlink(L["link"])
            os.symlink(impostor, L["link"])
        self.assertEqual(run(L, swap_link).reason, f"genuine ran as {L['hook']}")
        self.assertEqual(spawned, [L["hook"]])
        self.assertEqual(os.readlink(L["link"]), impostor, "the swap happened")
        self.assert_verdict("the next event sees the swap", L["link"], L["pin"], "pin-mismatch")
        # Handled: the keg renamed away between verify() and exec is a transport refusal.
        L = self.homebrew()
        keg = os.path.join(L["prefix"], "Cellar/isonapse/1.0")
        with self.assertRaises(Unavailable) as raised:
            run(L, lambda _: os.rename(keg, keg + ".gone"))
        self.assertEqual(raised.exception.code, "hook-transport")
        self.assertTrue(os.path.isdir(keg + ".gone"), "the rename happened")
        # RESIDUAL (documented, not closed): a writer of an accepted directory
        # who replaces the keg between verify() and exec runs other bytes for
        # that one event. Pinned so closing it is a deliberate change.
        L = self.homebrew()
        keg = os.path.join(L["prefix"], "Cellar/isonapse/1.0")

        def replace_keg(_):
            os.rename(keg, keg + ".old")
            os.makedirs(os.path.join(keg, "bin"))
            self.file(L["hook"], IMPOSTOR)
        self.assertEqual(run(L, replace_keg).reason, f"impostor ran as {L['hook']}")
        self.assert_verdict("the next event refuses the replaced keg", L["link"], L["pin"], "pin-mismatch")


    # -----------------------------------------------------------------------
    # The pin file (--hook-sha256-file): read on every verification under the
    # Hook path rule, never a link, exactly one lowercase SHA-256. The same
    # case names and expected causes are pinned in typescript/tests/adk.test.js.
    # -----------------------------------------------------------------------
    def pinned(self, content=None, mode=0o600):
        L = self.homebrew()
        pins = os.path.join(L["base"], "pins")
        self.directory(pins, 0o700)
        pin_file = os.path.join(pins, "hook.sha256")
        self.file(pin_file, (f"{L['pin']}\n" if content is None else content).encode(), mode)
        return dict(L, pins=pins, pin_file=pin_file)

    def test_pin_file_valid_is_read_and_the_link_is_followed_to_the_keg(self):
        L = self.pinned()
        self.assert_pin_verdict("pin with a trailing newline", L["link"], L["pin_file"], "ok", L["hook"])
        self.file(L["pin_file"], L["pin"].encode(), 0o600)
        self.assert_pin_verdict("pin without a trailing newline", L["link"], L["pin_file"], "ok", L["hook"])
        os.chmod(L["pin_file"], 0o400)
        self.assert_pin_verdict("read-only pin file", L["link"], L["pin_file"], "ok", L["hook"])
        os.chmod(L["pin_file"], 0o600)
        # Ancestors may be links under the Hook path rule; only the leaf may not.
        os.symlink(L["pins"], os.path.join(L["base"], "pins-link"))
        self.assert_pin_verdict("owned link to the pin directory", L["link"],
                                os.path.join(L["base"], "pins-link/hook.sha256"), "ok", L["hook"])
        self.file(L["pin_file"], b"0" * 64 + b"\n", 0o600)
        self.assert_pin_verdict("stale pin (after an upgrade)", L["link"], L["pin_file"], "pin-file-mismatch")
        # Test for the test: the inline pin of the same bytes is accepted.
        self.assert_verdict("the same Hook pinned inline", L["link"], L["pin"], "ok", L["hook"])

    def test_pin_file_content_must_be_exactly_one_lowercase_sha256(self):
        L = self.pinned()
        pin = L["pin"]
        for label, content in (
            ("empty", ""),
            ("two trailing newlines", f"{pin}\n\n"),
            ("CRLF", f"{pin}\r\n"),
            ("uppercase", pin.upper()),
            ("63 characters", pin[1:]),
            ("65 hex characters", f"{pin}a"),
            ("a valid pin followed by more bytes", f"{pin}\nx"),
            ("BOM-prefixed", f"﻿{pin}"),
            ("NUL inside", f"{pin[:63]}\0"),
            ("leading space", f" {pin}"),
            ("4 KiB", f"{pin}\n" * 63),
        ):
            self.file(L["pin_file"], content.encode(), 0o600)
            self.assert_pin_verdict(label, L["link"], L["pin_file"], "pin-file-invalid")
        # Test for the test: the same file with the valid pin is accepted again.
        self.file(L["pin_file"], f"{pin}\n".encode(), 0o600)
        self.assert_pin_verdict("restored", L["link"], L["pin_file"], "ok", L["hook"])

    def test_pin_file_missing_link_mode_type_and_ancestry_are_refused(self):
        L = self.pinned()
        self.assert_pin_verdict("missing pin file", L["link"], os.path.join(L["pins"], "absent"), "pin-file-missing")
        self.assert_pin_verdict("missing pin directory", L["link"], os.path.join(L["base"], "absent/hook.sha256"),
                                "pin-file-missing")
        os.symlink(L["pin_file"], os.path.join(L["pins"], "link.sha256"))
        self.assertTrue(os.path.islink(os.path.join(L["pins"], "link.sha256")),
                        "fixture: the leaf is an owned link to a valid pin file")
        self.assert_pin_verdict("pin file that is a link", L["link"], os.path.join(L["pins"], "link.sha256"),
                                "pin-file-untrusted:file")
        for mode in (0o620, 0o602):
            os.chmod(L["pin_file"], mode)
            self.assert_pin_verdict(f"pin file mode {mode:o}", L["link"], L["pin_file"], "pin-file-untrusted:file")
        os.chmod(L["pin_file"], 0o600)
        self.directory(os.path.join(L["pins"], "dir.sha256"))
        self.assert_pin_verdict("directory as the pin file", L["link"], os.path.join(L["pins"], "dir.sha256"),
                                "pin-file-untrusted:file")
        os.mkfifo(os.path.join(L["pins"], "fifo.sha256"))
        self.assert_pin_verdict("FIFO as the pin file", L["link"], os.path.join(L["pins"], "fifo.sha256"),
                                "pin-file-untrusted:file")
        self.directory(os.path.join(L["base"], "ww"), 0o777)
        self.file(os.path.join(L["base"], "ww/hook.sha256"), f"{L['pin']}\n".encode(), 0o600)
        self.assert_pin_verdict("pin file in a world-writable directory", L["link"],
                                os.path.join(L["base"], "ww/hook.sha256"), "pin-file-untrusted:world-writable")
        self.assert_pin_verdict("pin file below a regular file", L["link"], L["pin_file"] + "/x",
                                "pin-file-untrusted:not-a-directory")
        # INJECTED ownership: a nonroot test cannot create another user's inode.
        for label, path, owner, outcome in (
            ("pin file owned by another user", L["pin_file"], UID + 4242, "pin-file-untrusted:file"),
            ("pin directory owned by another user", L["pins"], UID + 4242, "pin-file-untrusted:owner"),
            ("root-owned pin file is accepted", L["pin_file"], 0, "ok"),
        ):
            fired = []
            with self.forge_lstat(path, fired, st_uid=owner):
                self.assert_pin_verdict(label, L["link"], L["pin_file"], outcome, L["hook"])
            self.assertTrue(fired, f"{label}: the injected lstat result was used")
        self.assert_pin_verdict("same layout without injection", L["link"], L["pin_file"], "ok", L["hook"])

    def test_pin_file_configuration_and_the_pin_source_are_validated(self):
        L = self.pinned()
        for label, pin_file in (
            ("relative pin file path", "pins/hook.sha256"),
            ("NUL in the pin file path", L["pin_file"] + "\0x"),
            ("pin file path that is not well-formed Unicode", L["pins"] + "/\ud800"),
            ("pin file path that is not a string", 42),
            ("bytes pin file path", os.fsencode(L["pin_file"])),
        ):
            self.assert_pin_verdict(label, L["link"], pin_file, "pin-file-invalid")
        # Exactly one pin source: both, or neither, is a configuration error.
        self.assertEqual(verdict(L["link"], None, InstalledHook(L["link"], L["pin"], L["pin_file"])),
                         expected("invalid-configuration"), "both an inline pin and a pin file")
        self.assertEqual(verdict(L["link"], None, InstalledHook(L["link"])),
                         expected("invalid-configuration"), "no pin source")
        # The Hook path is still validated in pin-file mode.
        self.assert_pin_verdict("relative Hook path", "hb/bin/isonapse-hook", L["pin_file"], "invalid-configuration")
        # Path objects are accepted for both.
        self.assertEqual(InstalledHook.from_pin_file(Path(L["link"]), Path(L["pin_file"])).verify(), Path(L["hook"]))

    def test_pin_file_replaced_between_the_walk_and_the_open_is_refused(self):
        L = self.pinned()
        before = os.lstat(L["pin_file"]).st_ino

        def replace():
            self.file(L["pin_file"] + ".new", f"{L['pin']}\n".encode(), 0o600)
            os.rename(L["pin_file"] + ".new", L["pin_file"])
        with self.on_open(L["pin_file"], replace):
            self.assert_pin_verdict("pin file replaced after the walk", L["link"], L["pin_file"], "changed")
        self.assertNotEqual(os.lstat(L["pin_file"]).st_ino, before, "the replacement happened")
        self.assert_pin_verdict("the replaced pin file verifies on the next event", L["link"], L["pin_file"],
                                "ok", L["hook"])

    def test_pin_file_client_keeps_the_pin_source_and_rereads_it_on_every_call(self):
        L = self.pinned()
        client = Client(InstalledHook.from_pin_file(L["link"], L["pin_file"]), "pi", timeout=5)
        request = {"session_id": "session", "tool_use_id": "call"}

        def call():
            return client.decide("tool_call", request, boundary="pre")
        self.assertEqual((client.installed.sha256, client.installed.sha256_file), (None, L["pin_file"]))
        self.assertEqual(call().reason, f"genuine ran as {L['hook']}")
        self.file(L["pin_file"], b"0" * 64 + b"\n", 0o600)
        with self.assertRaises(Unavailable) as raised:
            call()
        self.assertEqual((raised.exception.code, str(raised.exception)), ("hook-identity:pin-mismatch", PIN_FILE_MISMATCH))
        self.file(L["pin_file"], b"not a pin\n", 0o600)
        with self.assertRaises(Unavailable) as raised:
            call()
        self.assertEqual({"code": raised.exception.code, "message": str(raised.exception)}, expected("pin-file-invalid"))
        # Re-pinning (the upgrade cycle): the same Client, the same definition.
        os.unlink(L["link"])
        self.directory(os.path.join(L["prefix"], "Cellar/isonapse/2.0/bin"))
        new = os.path.join(L["prefix"], "Cellar/isonapse/2.0/bin/isonapse-hook")
        self.file(new, IMPOSTOR)
        os.symlink("../Cellar/isonapse/2.0/bin/isonapse-hook", L["link"])
        self.file(L["pin_file"], f"{L['pin']}\n".encode(), 0o600)
        with self.assertRaises(Unavailable) as raised:
            call()
        self.assertEqual((raised.exception.code, str(raised.exception)), ("hook-identity:pin-mismatch", PIN_FILE_MISMATCH))
        self.file(L["pin_file"], f"{sha(IMPOSTOR)}\n".encode(), 0o600)
        self.assertEqual(call().reason, f"impostor ran as {new}")

if __name__ == "__main__":
    unittest.main()
