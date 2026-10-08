# Isonapse Hook ADK for Python

> **Status — Public beta:** Ships as a wheel in current Agent Hook release
> archives; it is not published to PyPI.

This package implements Hook Adapter Protocol v1. Python 3.10 or later on macOS
and Linux is supported. There are no runtime dependencies. Windows transport is
not implemented; it refuses rather than claiming process-tree cleanup.

## Install and pin

Current Agent Hook release archives carry the adapter toolkit,
`isonapse-adapter-toolkit.tar.gz`: with Homebrew at
`$(brew --prefix)/share/isonapse/`, with `install.sh` next to the installed
binaries (by default `~/.isonapse/bin/`). Extract it and install the wheel into
a virtual environment, offline:

```sh
tar -xzf "$(brew --prefix)/share/isonapse/isonapse-adapter-toolkit.tar.gz"
python3 -m venv .venv
.venv/bin/python -m pip install --no-index --no-deps \
  ./isonapse-adapter-toolkit/python/isonapse_hook_adk-1.1.0-py3-none-any.whl
```

Use a virtual environment rather than changing your system Python. The package
version alone does not identify the release it came from; the toolkit's
`TOOLKIT.json` records the version and the SHA-256 of the wheel. Upgrade by
installing the wheel from a newer release's toolkit into that environment;
remove it with `python3 -m pip uninstall isonapse-hook-adk`.

## Native callback API

`python -m isonapse_hook_adk init agent.py` creates a non-overwriting native Read
starter. The starter takes an inline pin (`--hook-sha256`); to read the pin
from a pin file instead, construct the Hook with `InstalledHook.from_pin_file`.
Review it, then register the exact interpreter/script using the
toolkit's `HOST-PROFILES.md`. `Runtime` from `isonapse_hook_adk.runtime` wraps
`start()`, `tool(call_id, canonical_name, arguments, native_callback)` and `end()`.
It snapshots arguments/results across checks, reports the actual applied input,
and never retries an executed effect. The native callback must return bounded
JSON; unsupported outputs are withheld with an explicit completion-unknown
error. The effect has already run in that case: do not repeat it to retry
completion. It does not assess business success.

`InstalledHook(Path, sha256)` selects an explicit absolute Hook path and an
independently trusted SHA-256 installation pin. Pass the Hook path that
Isonapse recorded as `hook_binary_path` (a Homebrew `bin/` link is supported).
It does not search PATH or accept executable settings from a model request.

- `verify()` resolves the path from `/` one component at a time.
  - It follows a link only when you or root own it, its directory has already
    passed, and the chain has at most 8 links.
  - Each directory must be owned by you or root and must not be
    world-writable; a root-owned sticky directory is tolerated.
  - A group-writable directory passes only if its group is macOS `admin`
    (gid 80), or, on Linux, if you own it and its group is your private group
    (gid = uid).
  - The Hook must be a regular file of at most 1 GiB, owned by you or root,
    not group- or world-writable, whose SHA-256 equals the pin.
  - The path is re-resolved after hashing and must name the same file.
  - `verify()` returns the resolved path, and the client executes it.
  - Residual: other macOS admin accounts can race a rename between verify and
    exec. The HOST-PROFILES registration rule is unchanged.

The installation owner and root remain trusted; this is not protection against
a malicious owner replacing an executable.

The pin can come from a pin file instead:
`InstalledHook.from_pin_file(path, pin_file)`.

- The file is read on every `verify()`.
- It must be named by an absolute path, must not itself be a link, must be
  owned by you or root and writable only by its owner, must sit in
  directories that pass the rule above, and must hold exactly 64 lowercase
  hexadecimal characters with at most one trailing newline.
- The causes are `hook-identity:pin-file-missing`, `-untrusted` and
  `-invalid`. A stale pin file is `hook-identity:pin-mismatch`, and its text
  names `isonapse hook adk-pin`.
- Give exactly one pin source.
- `isonapse hook adk-pin` writes the file after verifying the Hook against its
  signed release manifest. Rerun it after every Isonapse upgrade; the host's
  hook definition does not change.

`Client(installed, host, timeout=50)` sends bounded JSON to the installed Hook.
Call `check_version()` during adapter startup. `decide(event, request,
boundary="pre" | "post" | "lifecycle", cancel=threading.Event())` returns a
decoded decision or raises `Unavailable`. Provide a trusted, stable `session_id`
and the same native `tool_use_id` across preparation and completion. Pass the
host ID issued by operator registration, never one supplied in tool arguments.

`Unavailable` carries a `code` that names the class of failure; branch on it,
never on the message text. No message names a path.

| `code` | Meaning |
| --- | --- |
| `hook-identity:pin-mismatch` | The Hook does not match the SHA-256 pin. After an Isonapse upgrade, run `isonapse hook adk-pin` (pin file), or recompute the inline pin and update it. The message differs by pin source. |
| `hook-identity:untrusted-path` | The Hook path breaks one of the `verify()` rules above; the message names the rule. |
| `hook-identity:missing` | Nothing exists at the configured Hook path. |
| `hook-identity:changed` | The Hook path or file, or the pin file, changed during verification, for example during an upgrade. |
| `hook-identity:invalid-configuration` | The Hook path is not absolute, the inline pin is not 64 lowercase hexadecimal characters, or there is not exactly one pin source. |
| `hook-identity:pin-file-missing` | Nothing exists at the pin file path, or it cannot be read. |
| `hook-identity:pin-file-untrusted` | The pin file or its path breaks the pin file rule above; the message names the rule. |
| `hook-identity:pin-file-invalid` | The pin file path is not absolute, or the file does not hold exactly one lowercase SHA-256. |
| `hook-transport` | The verified Hook could not be started or its transport failed. |
| `hook-protocol` | The Hook answered with an invalid or incompatible Protocol v1 response or version. |

`execute(decision, original, effect, approve=callback)` invokes your real native
effect exactly once with a complete replacement input when one was authorized.
It does not merge removed fields back into that input. Deny/unavailable and
missing or negative approval never invoke the effect. A lifecycle/post response
cannot authorize execution. `deliver(decision, original)` returns only the
allowed model-facing result or replacement; otherwise it raises `Refused`.
Decoded decisions are single-use. An approval callback cannot mutate the selected
input. If using the low-level API, retain your own immutable snapshot before
calling `decide`; do not execute or deliver a caller-owned object that changed
while the check was pending.

## Hook-command hosts

`isonapse_hook_adk.hook_command` serves hook-command hosts: runtimes that
start one fresh adapter process per native event, hand it one JSON event on
stdin and read a host-shaped answer, so `Runtime` (pre, effect and post inside
one call) does not fit. `read_host_event(stream=None)` reads one bounded,
strictly decoded event (1 MiB, valid UTF-8, no duplicate keys, an object) from
stdin or the given binary stream. `hook_command(client, event, approve=None,
check_version=False, cancel=None)` takes a canonical event (`hook_event_name`
of `SessionStart`, `SessionEnd`, `PreToolUse` or `PostToolUse` with
`session_id`, `cwd`, and `tool_use_id`, `tool_name`, `tool_input`,
`tool_response` as applicable), forwards only those canonical fields to the
Hook, and returns a frozen `Outcome` whose `kind` is the only field to branch
on: lifecycle `acknowledged`/`refuse`; pre-action `proceed` (run the exact
original input), `rewrite` (run exactly `input`) or `refuse`; post-action
`deliver`, `replace` (show exactly `output`; `has_output` is true) or
`withhold`. Transport failure and every refusal are outcomes, never allows; an
unsupported or malformed event raises before the Hook runs. An outcome caused
by an `Unavailable` carries its `code` as `cause`. Without `approve` an `ask`
is a refusal. The adapter renders the host's wire format itself and must answer
every path explicitly when its host fails open on a silent or crashed hook.
This Python helper is covered by the package's fake-client and real-subprocess
tests; the maintained per-event reference adapter (`reference/codex/`) is
TypeScript, because on macOS the framework and Homebrew Python interpreters
fail the owner-controlled ancestry check that `host-profile create` applies, so
a Python per-event adapter has not been proven against the real daemon.

## Operating rules

Always surface `decision.operator_message` through the host's operator channel.
Never parse reason text to make a decision. Host approval is not proof of a
durable Isonapse receipt. Report completion using the same call ID and the actual
applied input, even when the native effect failed. A completion retry must not
repeat the effect. If the host cannot replace input/output or obtain approval,
declare that limitation and stop rather than silently ignoring the instruction.

Timeout/cancellation stops the Hook process group and closes local pipes. An
escaped, independently detached descendant is outside that group; the library
does not claim to terminate unrelated processes. Responses are limited to 1 MiB,
diagnostics to 64 KiB, and transport time to 50 seconds. Raw stderr/input/output
is not included in transport exceptions.

In the toolkit's source tree, run
`PYTHONPATH=src python3 -m unittest discover -s tests -v` from `python/` for
the package's protocol and real-subprocess tests. These explicitly pinned
protocol fixtures are not proof of daemon enforcement or receipt persistence.

Licensed under Apache-2.0; see LICENSE.

The maintained Hermes integration bundles this package's `strict_json.py`
unchanged as `_adk_json.py`. Its native-boundary tests exercise that same source;
host-specific event mapping and the installed cohort-bound adapter remain Hermes
integration code, not a competing implementation of the generic ADK runtime.
