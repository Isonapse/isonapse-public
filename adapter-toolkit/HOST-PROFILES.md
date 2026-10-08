# Host profiles and compatibility

Protocol v1 requires Isonapse Agent Hook 0.3.0-beta or later. An adapter must
always request `--adapter-protocol 1`; receiving any other `protocolVersion`
is a hard refusal, never a downgrade. The hook's explicit rejection of an
unknown `--host` id is the registration handshake.

| Host id | Reference | Declared capability boundary |
| --- | --- | --- |
| `hermes` | `reference/hermes/` | pre-action refusal and lifecycle; no trusted output perimeter |
| `pi` | `reference/pi/` | input rewrite, output rewrite, and native ask |
| `adk-codex-<digest>` (operator-registered) | `reference/codex/` | input rewrite only (shell command, single-file `apply_patch`, MCP arguments); no ask; no exact output replacement (a result can only be withheld); cooperative fail-open host; proven with codex-cli 0.155.1 on macOS |

Builtin profiles retain their audited native mappings. Additional runtimes use
operator-admitted profiles with canonical events and tool inputs. Profile data
never contains executable mappings or replaces policy. Native mapping belongs
in your reviewed adapter. Approval grants trust in that adapter's capability
claims; it cannot make an uncooperative host enforce them. The Codex row is
not a builtin: its id is computed by `host-profile create` on the operator's
machine, and its `reference/codex/` adapter is the maintained example of a
**hook-command host**, a runtime that starts one fresh adapter process per
native event instead of loading a long-lived plugin.

## Register a new runtime

Use a candidate containing `isonapse hook host-profile` (older 0.3.0 builds may
not include it). Python 3.10+ and Node 22+ packages support macOS/Linux; Windows
process authentication is not implemented. Create a starter using
`python -m isonapse_hook_adk init my_agent.py` or
`npx --no-install isonapse-hook-adk init my-agent.mjs` after package installation.
Review the generated native Read callback before giving it access to files. For
a hook-command host, start from `reference/codex/` and the packages'
`hook-command` helper instead of the in-process `Runtime` starter.

```sh
isonapse hook host-profile create my-runtime \
  --executable /absolute/canonical/python3 \
  --script /absolute/my_agent.py \
  --input-replacement --output-replacement > profile.json
isonapse hook host-profile validate profile.json
isonapse hook host-profile register profile.json
isonapse hook restart
isonapse hook host-profile list
```

Creation prints JSON only and changes no runtime authority. Registration asks
for OS authentication, records signed approval of the exact profile, and stages
configuration; restart activates it. Managed installations require enterprise
lifecycle permission. `list` reports configured IDs, not live readiness. Pass
the complete `adk-<name>-<digest>` ID to the library, never a model-selected ID.
Launch scripts as the exact executable followed immediately by their absolute
script path; `-m`, `-c`, wrappers and environment-selected entrypoints do not
match. Declare approval/prompt capabilities only when native callbacks support
them. Session start/end and pre/post-tool are the canonical baseline.

Run `register`, `register --replace` and `remove` from a normal operator
terminal. Each requires fresh OS authentication of the operator, and the daemon
treats a process started from inside Codex, Claude Code or another governed
agent as an agent process, so registration cannot be completed from a shell
that such an agent opened. Do not automate it through the agent you are trying
to govern.

### Choose a registrable interpreter

The daemon authenticates every Hook connection by walking its process ancestry
and comparing the running interpreter's **kernel-visible executable path** with
the pinned path exactly, then its first argument with the pinned script. The
path a language reports for itself is not always the path the kernel runs:

- macOS framework Python (python.org installs, Xcode's `/usr/bin/python3`)
  re-executes `…/Python.app/Contents/MacOS/Python`, so the `bin/python3` a
  shell sees is never the process the daemon sees. `create` also refuses these
  paths outright with `ADK issuer ancestry is not owner-controlled`: the
  `/Library/Frameworks/Python.framework` tree is group-writable by `admin`,
  and the same check refuses Homebrew's `/opt/homebrew/Cellar` tree. A
  `python3 -m venv` interpreter canonicalizes to the framework and is refused
  for the same reason.
- A `python3 -m venv --copies` interpreter and `/usr/bin/python3` pass
  `create`, but do not register them: the interpreter they launch is the
  framework's `Python.app/Contents/MacOS/Python`, not the copied path, so the
  running process is not expected to match the pin.
- Version-manager shims (`~/.asdf/shims/node`, similar wrapper scripts) are
  shell scripts, not the interpreter; they never match.

`create`, `validate` and the daemon apply one rule to the interpreter and to
the adapter file alike, exactly this:

- The path must be canonical: no symbolic link at any component
  (`ADK issuer path must be canonical without symlinks`).
- Every parent directory, up to `/`, must be a directory owned by you or by
  root that is neither group- nor world-writable, **except** that a
  root-owned directory with the sticky bit set (mode `1777`, such as `/tmp`
  and `/private/tmp`) is tolerated even though it is world-writable
  (`ADK issuer ancestry is not owner-controlled`).
- The file itself must be a regular file owned by you or by root, not group-
  or world-writable (the sticky-bit exception does not apply to the file) and
  at most 1 GiB (`ADK issuer is not a bounded owner-controlled regular file`).

Two recipes work:

1. **An owner-controlled Node install**, for example asdf's real
   `~/.asdf/installs/nodejs/<version>/bin/node`: owned by you, not a symlink,
   and every parent directory passes the ancestry rule above (a version
   manager's install under your home does). `create` accepts that layout, and
   it is what the `reference/codex/` README asks for.
2. **A user-owned copy of the interpreter binary** placed in a directory only
   you can write (mode `0700`). On macOS, re-sign the copy ad hoc
   (`codesign --force --sign - <copy>`); an unsigned copy is killed at
   launch. Register the copy's path and launch the adapter with exactly that
   path. This is how the maintained registered-host and Codex tests run
   their interpreters, Node and the framework Python binary alike, against
   the real daemon.

`create` and `validate` name the check that failed; fix the interpreter
location rather than loosening directory permissions on a shared tree.

This issuer rule is not the ADK's rule for the installed **Hook**, and the two
now differ. Since ADK 1.1.0 `InstalledHook.verify()` follows a link that you
or root own, accepts a directory that only macOS `admin` (gid 80) or, on Linux,
your own private group can write, and then runs the resolved file, so the
Hook that Homebrew links into `bin/` is accepted. The issuer rule above is
unchanged: it still refuses links and group-writable trees, Homebrew's
included, for the interpreter and the adapter file. The registered adapter
must therefore be your own copy in a directory only you can write, never a
file inside a Homebrew keg.

The Hook's SHA-256 pin is a third check, separate from both rules and from the
registration digest. A host that keys its hook trust on the hook definition,
as Codex does, should read the pin from a pin file
(`--hook-sha256-file`, `InstalledHook.fromPinFile` or
`InstalledHook.from_pin_file`) that `isonapse hook adk-pin` writes after it
has verified the installed Hook against its signed release manifest. After an
upgrade only `isonapse hook adk-pin` is needed; the trusted definition is
never edited, and re-pinning needs neither `register --replace` nor a restart.
The pin file follows the Hook path rule, except that the pin file itself must
not be a link; it must be owned by you or root, writable only by its owner,
and hold exactly one lowercase SHA-256. Anything else is a `pin-file-missing`,
`pin-file-untrusted` or `pin-file-invalid` identity refusal. See
`INTEGRATION.md` step 5 and "After an Isonapse upgrade".

### Events a registered id accepts

A registered id maps exactly `session-start`, `session-end`, `pre-tool-use`,
`post-tool-use` and, only when the profile declares `--prompt-boundary`,
`user-prompt-submit`. Every other native event, including `stop`, fails closed
in all gate modes with an unknown-event refusal and no receipt. The conformance
suite's `stop-lifecycle` case drives a stub hook that answers `stop`; it exists
for the builtin mappings and does not show that the real Hook accepts `stop`
from a registered id, which it does not. An adapter for a registered id must
therefore not wire a per-turn stop hook. Wire session start, session end and
the pre/post-tool pair, and declare the prompt boundary only when the host can
veto a prompt natively.

### Hook-command hosts

Some hosts do not load a plugin. They start a fresh adapter process for every
native event, hand it one JSON event on stdin and read a host-shaped answer
from stdout and the exit status. Nothing survives between events except what
the Hook and daemon persist, which is sufficient: registered-host sessions bind
to the authenticated issuer, not to an adapter process. Use
`@isonapse/hook-adk/hook-command` or `isonapse_hook_adk.hook_command` and
render the host's wire format yourself. Every answer must be explicit: such a
host typically runs the tool when a hook crashes, times out, is missing or
answers in an unsupported shape (see the fail-open checklist in `README.md`).

`reference/codex/` is proven with OpenAI codex-cli 0.155.1 on macOS against
the real daemon, Hook and packages, one process per event, in Profile, Normal
and Enforce, and with the real `codex exec` binary against a scripted local
model. The adapter, package and daemon tests also run on Linux; the real
Codex binary is not proven there. Other Codex versions, Windows, subagent tool
calls, `write_stdin` continuations and hosted tools are not proven; Codex's
hook contract changes between releases, so re-run the maintained proof before
trusting a newer version. `reference/codex/supported-versions.json` lists the
proven versions: the maintained real-binary tests refuse a Codex below its
floor and, with `ISONAPSE_E2E_REQUIRE_CODEX=1`, any version it does not list
unless `ISONAPSE_E2E_CODEX_QUALIFY` names that exact version for a
qualification run.

The digest covers pinned executable/script bytes and all capability flags.
Changing the entrypoint or capabilities requires explicit `register --replace`
and restart. `host-profile remove <name>` revokes and removes the configured
profile; restart to deactivate the current snapshot. Missing/pruned approvals,
changed pins, duplicate names and overlapping issuers refuse activation. Keep
the approval history or reapprove explicitly after retention removes it.

Executable-only profiles trust all code that executable can run. A script pin
does not attest imported modules, plugins or already loaded code. The operator
must control and review the whole runtime installation. File pins and process
identity do not isolate malicious code running as the installation owner.

To add a host, open a public feature request containing:

- upstream host/project and version range;
- stable session and tool-call identity sources;
- every native event and canonical event mapping;
- exact tool-name/input/output mapping, including replacement mechanics;
- honest `can_rewrite_input`, `can_rewrite_output`, and `can_ask` evidence;
- lifecycle and nested-agent boundaries, including known gaps;
- for a hook-command host, the stdin/stdout/exit contract and what the host
  does when a hook crashes, times out or is missing;
- a link to an Apache-2.0-compatible adapter implementation; and
- a green transcript from `python3 conformance/run.py --adapter …`.

Upstream contributions can still add maintained builtin mappings. They are not
required for the operator-admitted canonical runtime path above. An unregistered
ID or a process other than the approved issuer remains fail-closed.
