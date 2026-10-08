"""Isonapse Hook ADK. No transport failure authorizes an effect.

Host code owns stable identity and execution. This library never discovers a
binary through PATH, reads model-supplied host settings, or runs a shell.
"""
from __future__ import annotations

from dataclasses import dataclass
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import threading
import time
import weakref
from typing import Any, Callable, Literal
from .strict_json import loads as strict_loads

MAX_BYTES = 1024 * 1024
MAX_DIAGNOSTICS = 64 * 1024
MAX_TIMEOUT = 50.0
MAX_BINARY = 1024 * 1024 * 1024
MAX_LINKS = 8
DecisionKind = Literal["allow", "deny", "ask", "unavailable"]


class Unavailable(RuntimeError):
    """No usable decision. Never catch this as permission to execute.

    `code` names the cause class when the Hook could not be consulted:
    `hook-identity:<cause>` (`pin-mismatch`, `untrusted-path`, `missing`,
    `changed`, `invalid-configuration`, `pin-file-missing`,
    `pin-file-untrusted`, `pin-file-invalid`), `hook-transport` or
    `hook-protocol`; otherwise None.
    """

    def __init__(self, *args: Any, code: str | None = None):
        super().__init__(*args)
        self.code = code


class Refused(RuntimeError):
    """The effect/result must not be delivered automatically."""


def _object(value: Any) -> bool:
    return isinstance(value, dict) and all(isinstance(key, str) for key in value)


def _json_value(value: Any, depth: int = 0) -> None:
    if depth > 256:
        raise ValueError("JSON nesting limit")
    if value is None or type(value) in (bool, int):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite JSON number")
    elif isinstance(value, str):
        value.encode("utf-8", errors="strict")
    elif isinstance(value, list):
        for item in value:
            _json_value(item, depth + 1)
    elif _object(value):
        for key, item in value.items():
            _json_value(key, depth + 1)
            _json_value(item, depth + 1)
    else:
        raise ValueError("non-JSON value")


def snapshot(value: Any) -> Any:
    """Copy only bounded JSON values; never coerce host objects into new input."""
    try:
        _json_value(value)
        encoded = json.dumps(value, allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_BYTES:
            raise ValueError("JSON size limit")
        return json.loads(encoded)
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise Unavailable("Value is not bounded JSON") from error


@dataclass(frozen=True, eq=False)
class Decision:
    kind: DecisionKind
    reason: str | None = None
    effective_input: dict[str, Any] | None = None
    updated_output: Any = None
    has_output: bool = False
    operator_message: str | None = None
    retryable: bool | None = None
    _boundary: str | None = None

_decisions = weakref.WeakKeyDictionary()


def decode(raw: bytes, boundary: Literal["pre", "post", "lifecycle"]) -> Decision:
    """Validate known v1 fields; unknown extension fields grant no capability."""
    try:
        if len(raw) > MAX_BYTES or boundary not in ("pre", "post", "lifecycle"):
            raise ValueError()
        data = strict_loads(raw)
        _json_value(data)
        if not _object(data) or type(data.get("protocolVersion")) is not int or data["protocolVersion"] != 1:
            raise ValueError()
        kind = data.get("decision")
        if kind not in ("allow", "deny", "ask", "unavailable"):
            raise ValueError()
        for field in ("reason", "operatorMessage"):
            if field in data and not isinstance(data[field], str):
                raise ValueError()
        if "retryable" in data and type(data["retryable"]) is not bool:
            raise ValueError()
        if "effectiveInput" in data and not _object(data["effectiveInput"]):
            raise ValueError()
        if kind == "allow" and ("reason" in data or "retryable" in data):
            raise ValueError()
        if kind != "allow" and not data.get("reason", "").strip():
            raise ValueError()
        if kind != "unavailable" and "retryable" in data:
            raise ValueError()
        if kind == "unavailable" and ("retryable" not in data or "effectiveInput" in data or "updatedOutput" in data):
            raise ValueError()
        if "effectiveInput" in data and (boundary != "pre" or kind not in ("allow", "ask")):
            raise ValueError()
        if "updatedOutput" in data and (boundary != "post" or kind not in ("allow", "deny")):
            raise ValueError()
        if kind == "ask" and boundary != "pre":
            raise ValueError()
        result = Decision(kind, data.get("reason"), data.get("effectiveInput"),
                        data.get("updatedOutput"), "updatedOutput" in data,
                        data.get("operatorMessage"), data.get("retryable"), boundary)
        _decisions[result] = (boundary,
            json.dumps(data["effectiveInput"]) if "effectiveInput" in data else None,
            json.dumps(data["updatedOutput"]) if "updatedOutput" in data else None)
        return result
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise Unavailable("Invalid or incompatible Hook Protocol v1 response", code="hook-protocol") from error


# Installed Hook identity (#929). The texts never name a path: they reach the
# model as a deny reason. Keep them identical to the TypeScript package.
_IDENTITY = "Installed Hook identity could not be verified"


def _rules(subject: str, leaf: str) -> dict[str, str]:
    """The trust-rule texts, for the Hook path and for a pin file's path."""
    return {
        "owner": f"an entry on the {subject} path is not owned by you or root",
        "world-writable": f"a directory on the {subject} path is world-writable and not a root-owned sticky directory",
        "group-writable": f"a directory on the {subject} path is group-writable by a group other than macOS admin or your private Linux group",
        "links": f"the {subject} path has more than {MAX_LINKS} symbolic links",
        "not-a-directory": f"a component of the {subject} path is not a directory",
        "file": leaf,
    }


_UNTRUSTED = _rules("Hook", "the Hook is not a regular file of at most 1 GiB owned by you or root and writable only by its owner")
_PIN_UNTRUSTED = _rules("pin file", "the pin file is not a regular file owned by you or root and writable only by its owner")
_PIN_FIX = "Run isonapse hook adk-pin and use the pin file it names."
_IDENTITY_TEXT = {
    "pin-mismatch": f"{_IDENTITY} (pin mismatch): the Hook binary does not match the configured SHA-256 pin. After an Isonapse upgrade, recompute the pin from hook_binary_path, update the hook definition and re-trust it.",
    "missing": f"{_IDENTITY} (Hook missing): nothing exists at the configured Hook path; check hook_binary_path in the Isonapse configuration.",
    "changed": f"{_IDENTITY} (changed during verification): the Hook path or file changed while it was being verified, for example during an upgrade.",
    "invalid-configuration": f"{_IDENTITY} (invalid configuration): the Hook path must be absolute and the pin must be 64 lowercase hexadecimal characters.",
    "pin-file-missing": f"{_IDENTITY} (pin file missing): nothing exists at the configured pin file path. {_PIN_FIX}",
    "pin-file-invalid": f"{_IDENTITY} (pin file invalid): the pin file path must be absolute and the file must hold exactly one SHA-256 as 64 lowercase hexadecimal characters. {_PIN_FIX}",
}
# A stale pin FILE is fixed by re-pinning, never by editing the hook
# definition: that edit is what makes a host such as Codex un-trust it.
_PIN_FILE_MISMATCH = f"{_IDENTITY} (pin mismatch): the Hook binary does not match the SHA-256 in the pin file. After an Isonapse upgrade, run isonapse hook adk-pin; the hook definition does not change."
# A pin file holds 64 lowercase hex characters and at most one trailing "\n".
_MAX_PIN_FILE = 65


def _refusal(cause: str) -> Unavailable:
    return Unavailable(_IDENTITY_TEXT[cause], code=f"hook-identity:{cause}")


@dataclass(frozen=True)
class _Subject:
    """What a walk refuses with: the Hook path, or the path of a pin file."""
    untrusted: Callable[[str], Unavailable]
    missing: Callable[[], Unavailable]
    follow_leaf: bool
    leaf: Callable[[os.stat_result], bool]


_HOOK = _Subject(
    untrusted=lambda rule: Unavailable(f"{_IDENTITY} (untrusted path): {_UNTRUSTED[rule]}.",
                                       code="hook-identity:untrusted-path"),
    missing=lambda: _refusal("missing"),
    follow_leaf=True,
    leaf=lambda item: stat.S_ISREG(item.st_mode) and item.st_size <= MAX_BINARY,
)
_PIN_FILE = _Subject(
    untrusted=lambda rule: Unavailable(f"{_IDENTITY} (pin file untrusted): {_PIN_UNTRUSTED[rule]}. {_PIN_FIX}",
                                       code="hook-identity:pin-file-untrusted"),
    missing=lambda: _refusal("pin-file-missing"),
    # The pin file itself is never a link: only its directories may be.
    follow_leaf=False,
    leaf=lambda item: stat.S_ISREG(item.st_mode),
)


def _components(path: str) -> list[str]:
    # A plain split, identical in both packages: "" and "." are dropped, ".."
    # is resolved against the verified real directory (never lexically up front).
    return [part for part in path.split("/") if part not in ("", ".")]


def _owned(item: os.stat_result) -> bool:
    return item.st_uid in (0, os.geteuid())


def _absolute(value: Any) -> str | None:
    """The value as an absolute, NUL-free, UTF-8-encodable str path, or None."""
    try:
        value = os.fspath(value)
    except TypeError:
        return None
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        return None
    try:
        value.encode("utf-8")
    except UnicodeError:
        return None
    return value


def _trusted_writer_group(item: os.stat_result) -> bool:
    """The one group whose write permission a Hook directory may carry: macOS
    `admin` (Homebrew's Cellar, bin and opt), or on Linux the caller's own
    private group on a directory the caller owns."""
    if sys.platform == "darwin":
        return item.st_gid == 80
    if sys.platform.startswith("linux"):
        uid = os.geteuid()
        return item.st_uid == uid and item.st_gid == uid and item.st_gid == os.getegid()
    return False


def _trusted_directory(item: os.stat_result, subject: _Subject) -> None:
    if not stat.S_ISDIR(item.st_mode):
        raise subject.untrusted("not-a-directory")
    if not _owned(item):
        raise subject.untrusted("owner")
    root_sticky = item.st_uid == 0 and bool(item.st_mode & stat.S_ISVTX)
    if item.st_mode & 0o002 and not root_sticky:
        raise subject.untrusted("world-writable")
    if item.st_mode & 0o020 and not root_sticky and not _trusted_writer_group(item):
        raise subject.untrusted("group-writable")


def _entry(path: str, subject: _Subject) -> os.stat_result:
    try:
        return os.lstat(path.encode("utf-8"))
    except OSError as error:
        raise subject.missing() from error


def _resolve_trusted(path: str, subject: _Subject = _HOOK) -> tuple[str, os.stat_result]:
    """Resolve from `/` one component at a time. A link is followed only when
    its own inode is owned by root or the caller and the directory holding it
    has already passed; every directory reached must pass before anything
    inside it is examined. Returns the real path of a file that passes. The
    same walk serves the Hook and a pin file (`subject`)."""
    _trusted_directory(_entry("/", subject), subject)
    directory: list[str] = []
    queue = _components(path)
    links = 0
    while queue:
        part = queue.pop(0)
        if part == "..":
            if not queue:
                raise subject.untrusted("file")
            if directory:
                directory.pop()
            continue
        candidate = "/" + "/".join([*directory, part])
        item = _entry(candidate, subject)
        if stat.S_ISLNK(item.st_mode):
            if not queue and not subject.follow_leaf:
                raise subject.untrusted("file")
            links += 1
            if links > MAX_LINKS:
                raise subject.untrusted("links")
            if not _owned(item):
                raise subject.untrusted("owner")
            # A target that is not UTF-8 cannot be named losslessly by a
            # string path, so it is refused exactly as in the TypeScript package.
            try:
                target = os.readlink(candidate.encode("utf-8")).decode("utf-8")
            except (OSError, UnicodeError) as error:
                raise subject.missing() from error
            if target.startswith("/"):
                directory = []
            queue = [*_components(target), *queue]
            continue
        if queue:
            _trusted_directory(item, subject)
            directory.append(part)
            continue
        if not subject.leaf(item) or item.st_mode & 0o022 or not _owned(item):
            raise subject.untrusted("file")
        return candidate, item
    raise subject.untrusted("file")


def _read_pin_file(path: str) -> str:
    """Read the pin from a pin file under the same trust walk as the Hook.
    Read on every verification, so re-pinning takes effect without touching
    the host's hook definition."""
    resolved, walked = _resolve_trusted(path, _PIN_FILE)
    try:
        descriptor = os.open(resolved.encode("utf-8"), os.O_RDONLY | os.O_NOFOLLOW
                             | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as error:
        raise _refusal("changed" if error.errno in (errno.ENOENT, errno.ELOOP) else "pin-file-missing") from error
    try:
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (walked.st_dev, walked.st_ino):
                raise _refusal("changed")
            data = b""
            while len(data) < _MAX_PIN_FILE + 1:
                chunk = os.read(descriptor, _MAX_PIN_FILE + 1 - len(data))
                if not chunk:
                    break
                data += chunk
        except OSError as error:
            raise _refusal("pin-file-missing") from error
        # fullmatch on bytes: "$" would also accept a second trailing newline.
        if not re.fullmatch(rb"[0-9a-f]{64}\n?", data):
            raise _refusal("pin-file-invalid")
        return data[:64].decode("ascii")
    finally:
        os.close(descriptor)


@dataclass(frozen=True)
class InstalledHook:
    """Operator-selected absolute binary and independently obtained SHA-256 pin.

    The caller must obtain the pin from an approved installation, not from an
    event, environment override or the same untrusted download. The pin is
    either inline (`sha256`) or read from `sha256_file` on every verification
    (`InstalledHook.from_pin_file`); exactly one of the two must be set. A pin
    file is an absolute path to a regular file (never a link) owned by you or
    root, writable only by its owner, under directories that pass the rule
    below, holding 64 lowercase hex characters and at most one trailing
    newline; `isonapse hook adk-pin` writes it after verifying the Hook.

    `verify()` resolves the path from `/` one component at a time: it follows
    a link only when you or root own it, its directory has already passed and
    the chain has at most 8 links; every directory must be owned by you or root
    and must not be world-writable (a root-owned sticky directory is tolerated)
    or group-writable, except by macOS `admin` (gid 80) or, on Linux, your own
    private group (gid = uid) on a directory you own. The Hook must be a regular
    file of at most 1 GiB, owned by you or root, not group- or world-writable,
    whose SHA-256 equals the pin. The path is resolved again after hashing and
    must name the same file. `verify()` returns that resolved path and `Client`
    executes it. Residual: a writer of an accepted directory (the owner, root,
    or on macOS another `admin` member) can still race a rename between
    `verify()` and execution.
    """
    path: Path
    sha256: str | None = None
    sha256_file: Path | None = None

    @classmethod
    def from_pin_file(cls, path: Path | str, sha256_file: Path | str) -> "InstalledHook":
        """A Hook whose pin is read from `sha256_file` on every verification."""
        return cls(path, None, sha256_file)

    def verify(self) -> Path:
        path = _absolute(self.path)
        if path is None:
            raise _refusal("invalid-configuration")
        from_file = self.sha256_file is not None
        if not from_file:
            sha256 = self.sha256
            if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
                raise _refusal("invalid-configuration")
            pin = sha256
        else:
            # Exactly one pin source: an inline pin beside a pin file is ambiguous.
            if self.sha256 is not None:
                raise _refusal("invalid-configuration")
            pin_path = _absolute(self.sha256_file)
            if pin_path is None:
                raise _refusal("pin-file-invalid")
            pin = _read_pin_file(pin_path)
        resolved, first = _resolve_trusted(path)
        try:
            # O_NONBLOCK: a FIFO swapped in after the walk cannot stall the open.
            descriptor = os.open(resolved.encode("utf-8"), os.O_RDONLY | os.O_NOFOLLOW
                                 | os.O_CLOEXEC | os.O_NONBLOCK)
        except OSError as error:
            raise _refusal("changed" if error.errno in (errno.ENOENT, errno.ELOOP) else "missing") from error
        try:
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (first.st_dev, first.st_ino):
                    raise _refusal("changed")
                digest = hashlib.sha256()
                size = 0
                while chunk := os.read(descriptor, 65536):
                    size += len(chunk)
                    if size > MAX_BINARY:
                        raise _refusal("changed")
                    digest.update(chunk)
                after = os.fstat(descriptor)
            except OSError as error:
                raise _refusal("missing") from error
            if ((first.st_dev, first.st_ino, first.st_size, first.st_mtime_ns)
                    != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
                raise _refusal("changed")
            # The path must still name the hashed file once hashing is done.
            try:
                again, second = _resolve_trusted(path)
            except Unavailable as error:
                raise _refusal("changed") from error
            if again != resolved or (second.st_dev, second.st_ino) != (after.st_dev, after.st_ino):
                raise _refusal("changed")
            if digest.hexdigest() != pin:
                if from_file:
                    raise Unavailable(_PIN_FILE_MISMATCH, code="hook-identity:pin-mismatch")
                raise _refusal("pin-mismatch")
            return Path(resolved)
        finally:
            os.close(descriptor)


def _stop(process: subprocess.Popen[bytes]) -> None:
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except ProcessLookupError:
        pass
    process.wait(timeout=2)


def _transport(message: str) -> Unavailable:
    return Unavailable(message, code="hook-transport")


def _exchange(argv: list[str], payload: bytes, timeout: float,
              cancel: threading.Event | None = None) -> bytes:
    if not 0 < timeout <= MAX_TIMEOUT or len(payload) > MAX_BYTES:
        raise _transport("Transport budget is invalid or exceeded")
    if cancel and cancel.is_set():
        raise _transport("Hook operation cancelled before execution")
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=os.name == "posix")
    except OSError as error:
        raise _transport("Verified Hook could not be started") from error
    output = bytearray()
    diagnostics = 0
    sent = 0
    selector = selectors.DefaultSelector()
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    for stream in (process.stdin, process.stdout, process.stderr):
        os.set_blocking(stream.fileno(), False)
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    if payload:
        selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
    else:
        process.stdin.close()
    deadline = time.monotonic() + timeout
    try:
        while selector.get_map() or process.poll() is None:
            if (cancel and cancel.is_set()) or time.monotonic() >= deadline:
                raise _transport("Hook transport unavailable, cancelled or exceeded its budget")
            for key, _ in selector.select(min(0.05, max(0, deadline-time.monotonic()))):
                if key.data == "stdin":
                    sent += os.write(key.fd, payload[sent:sent+65536])
                    if sent == len(payload):
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                    continue
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                elif key.data == "stdout":
                    output.extend(chunk)
                    if len(output) > MAX_BYTES:
                        raise _transport("Hook response exceeded its budget")
                else:
                    diagnostics += len(chunk)
                    if diagnostics > MAX_DIAGNOSTICS:
                        raise _transport("Hook diagnostics exceeded their budget")
        if process.returncode != 0:
            raise _transport("Hook did not return a successful protocol response")
        return bytes(output)
    except OSError as error:
        raise _transport("Hook transport failed") from error
    finally:
        try:
            _stop(process)
        finally:
            selector.close()
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()


class Client:
    def __init__(self, installed: InstalledHook, host: str, *, timeout: float = MAX_TIMEOUT):
        if os.name != "posix":
            raise Unavailable("ADK v1 transport currently supports macOS and Linux process groups")
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,92}", host):
            raise ValueError("Host identity must come from operator registration")
        self.installed, self.host, self.timeout = installed, host, timeout

    def check_version(self) -> str:
        installed, timeout = self.installed, self.timeout
        # Execute the verified real path, never the configured link (#929).
        executable = installed.verify()
        raw = _exchange([str(executable), "--version"], b"", timeout)
        value = raw.decode("utf-8", errors="strict").strip()
        match = re.fullmatch(r"isonapse-hook (\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.+-]+)?", value)
        if not match or tuple(map(int, match.groups())) < (0, 3, 0):
            raise Unavailable("Installed Hook version is incompatible with ADK v1", code="hook-protocol")
        return value

    def decide(self, event: str, request: dict[str, Any], *,
               boundary: Literal["pre", "post", "lifecycle"],
               cancel: threading.Event | None = None) -> Decision:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", event):
            raise ValueError("Invalid native event")
        if not _object(request) or not isinstance(request.get("session_id"), str) or not request["session_id"]:
            raise ValueError("A stable native session identity is required")
        if boundary in ("pre", "post") and (not isinstance(request.get("tool_use_id"), str) or not request["tool_use_id"]):
            raise ValueError("A stable native tool-call identity is required")
        try:
            _json_value(request)
            payload = json.dumps(request, allow_nan=False, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError, UnicodeError, RecursionError) as error:
            raise Unavailable("Host event is not bounded JSON") from error
        installed, host, timeout = self.installed, self.host, self.timeout
        executable = installed.verify()
        raw = _exchange([str(executable), event, "--host", host,
                         "--adapter-protocol", "1"], payload, timeout, cancel)
        return decode(raw, boundary)


def execute(decision: Decision, original: dict[str, Any], effect: Callable[[dict[str, Any]], Any],
            *, approve: Callable[[str], bool] | None = None) -> Any:
    """Invoke native execution once with exact authorized replacement arguments.

    Approval is a host decision, not a claim that an Isonapse receipt exists.
    The caller must report the same call identity and applied input at completion.
    """
    bound = _decisions.pop(decision, None)
    if bound is None or bound[0] != "pre":
        raise Refused("A decoded pre-action decision is required")
    selected = json.loads(bound[1]) if bound[1] is not None else snapshot(original)
    if decision.kind == "ask":
        if approve is None or approve(decision.reason or "Review required") is not True:
            raise Refused("Host approval was not granted")
    elif decision.kind != "allow":
        raise Refused("Isonapse did not permit this effect")
    return effect(selected)


def deliver(decision: Decision, original: Any) -> Any:
    """Return only the model-visible output permitted by a post-action response."""
    bound = _decisions.pop(decision, None)
    if bound is None or bound[0] != "post":
        raise Refused("A decoded post-action decision is required")
    if decision.kind == "allow" or (decision.kind == "deny" and decision.has_output):
        return json.loads(bound[2]) if bound[2] is not None else json.loads(json.dumps(original, allow_nan=False))
    raise Refused("Tool output must be withheld")
