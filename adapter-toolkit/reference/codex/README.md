# OpenAI Codex CLI reference adapter

> **Status — Public beta:** Ships in current Agent Hook release archives.
> For codex-cli 0.159.0 or newer; contract-tested on the versions
> `supported-versions.json` qualifies (today 0.164.0, on macOS arm64 and Linux x86_64). Codex is a cooperative, fail-open host.

`codex_hook.mjs` is a complete hook-command host adapter: Codex starts one
fresh process per hook event, writes one JSON event to its stdin and reads the
decision from stdout and the exit status. The adapter uses the shipped
`@isonapse/hook-adk` package (`Client`, `hook-command`); it copies no transport.
`hooks.json` is the Codex hook definition template.

## Supported Codex versions

`supported-versions.json` holds the version policy:

- **`floor`**: the oldest codex-cli this adapter is for, today 0.159.0. Older
  versions are below the floor and unsupported.
- **`qualified`**: the exact stable versions on which the maintained contract
  tests passed with the real `codex exec` binary, today 0.164.0 (on macOS arm64 and Linux x86_64).
- **Everything else at or above the floor is unqualified**: accepted, but no
  real Codex run has proven this adapter on it. That includes a newer stable
  and every build Codex's IDE extension or the ChatGPT desktop app bundles:
  the VS Code extension 26.1021.22027 bundles `codex-cli 0.164.0-alpha.11.1`,
  an alpha build. Codex's hook contract changes between releases, and on a
  fail-open host a changed contract can mean ungoverned tool calls.

A weekly real-Codex canary is to run the contract tests on Codex's newest
stable on macOS and Linux x86_64, starting with the main release that carries
it. A version joins `qualified` only after they pass on it. The adapter does not check the Codex version at runtime. Check `codex --version` (it prints
`codex-cli <version>`) after every Codex update and compare it with the
policy.

## Capability boundary (declare exactly this)

| Isonapse capability | Codex 0.164.0 | Adapter behaviour |
| --- | --- | --- |
| Pre-action refusal | yes | JSON `permissionDecision:"deny"` with a non-empty reason; every failure path answers explicitly |
| Input replacement | yes for `Bash` (`command`), `apply_patch` (patch text) and MCP tools (whole argument object) | `--input-replacement`; a replacement the host cannot apply exactly is a deny |
| Approval (`ask`) | **no**: Codex parses `ask` but does not support it and lets the tool run | never declared; an `ask` is a deny |
| Output replacement | **no exact replacement**: PostToolUse can only withhold a result | never declared; any required replacement or refusal is `decision:"block"` |
| Prompt boundary | yes: UserPromptSubmit can block a prompt (`decision:"block"`), not rewrite it | `--prompt-boundary`; a Hook deny is a block, see "Prompt checks" below |
| Codex's own permission requests | PermissionRequest for escalations Codex sends to the hook | every delivered event is denied |
| Opt-in `request_permissions` tool | ordinary PreToolUse before Codex's native approval flow | refused before the tool runs, with a distinct authorization DENY when the control plane decides |
| Lifecycle | SessionStart (60 s budget), SessionEnd (3 s budget), both advisory | acknowledged; cannot block |

The adapter preserves JSON integer arguments and exact input replacements,
including integers outside JavaScript's safe-number range. It uses the ADK's
lossless serializer for Codex's answer. A value outside the Hook's exact JSON
integer range is refused; it is never rounded and allowed.

Register the profile with `--input-replacement --prompt-boundary`. Codex
keeps the raw tool result when a PostToolUse hook withholds it; the model sees
the block reason instead. A withheld result does not undo the side effect.

**Codex is a cooperative, fail-open host.** A hook that crashes, times out,
prints invalid JSON, answers `ask`, answers `allow` without `updatedInput`, or
cannot be spawned (missing Node, wrong path) lets the tool run, and a
PermissionRequest hook that gives no answer leaves the request to Codex's own
approval prompt. The adapter converts every failure it can see into an
explicit answer (exit 2 with a non-empty stderr from its outermost handler,
which Codex reads as a deny, a block or a withheld result), but it cannot help
if it never starts. Its own deadlines stay below the template's 60 s timeouts
so that it, not Codex, answers on a hung daemon: one 50 s exchange for a
prompt, tool or permission event, and two 25 s exchanges (version probe, then
decision) for SessionStart.

A hook definition Codex has not been told to trust is silently skipped, which
means an ungoverned Codex. A maintained test shows it: the real `codex exec`
runs this `hooks.json` without persisted trust and without the bypass flag,
every scripted command runs, and the daemon writes zero receipts. That test
needs a real codex binary, so it is not part of every automated release
check; the real-Codex canary runs it. Codex keys its trust on the definition, not
on the files its command
reads. With codex-cli 0.155.1, editing a trusted definition returned it to the
untrusted state, and changing only the pin file the command names kept it
trusted (a recorded run). Neither is a maintained test. Read the Hook pin from
the pin file (below), keep the interpreter and adapter paths stable, and
re-trust after every edit of the definition.

Isonapse's direct-write self-protection covers Codex home/project configuration,
hooks and rules, registered adapter directories and their adjacent dependencies,
and supported shell startup files, including an absolute `ZDOTDIR`. Make operator
changes outside the governed session. `hook status --details` and `hook doctor --details` show the
resolved paths in their own environment; the quiet-host warning includes bounded
file-time watches of configuration/startup files and nested adapter dependencies.
This is a heuristic without a stored dependency baseline. It cannot establish that
Codex loaded a hook, or undo shell state established before governance.

## Prerequisites

- A working Agent Hook: `isonapse hook status` is healthy, on a release that
  ships the adapter toolkit and `isonapse hook adk-pin`.
- codex-cli 0.159.0 or newer, ideally a qualified version (see above).
- Node.js 22 or newer at a canonical path that only you or root can change: a
  non-symlink regular file owned by you or root and not group- or
  world-writable, whose parent directories are each owned by you or root and
  not group- or world-writable (a root-owned sticky-bit directory such as
  `/tmp` is tolerated); for example a version manager's real `.../bin/node`,
  never a shim script. `HOST-PROFILES.md` states the rule in full;
  `host-profile create` refuses Homebrew's `node` and framework paths that
  fail it.

## Install

On a machine with Docker, you usually do not need these steps: `isonapse setup`,
or the dashboard's Hosts page, adds Codex as one plan you approve in your
terminal. That plan installs and registers this adapter (prepared by
`isonapse hook codex-adapter`), trusts its hooks and sets
`approvals_reviewer = "user"`. The steps below are the manual path, for a
machine without the dashboard.

Run every step from a normal operator terminal, not from inside Codex or
Claude Code.

1. Extract the toolkit and install the adapter with its package. The toolkit
   ships in current Agent Hook release archives:

```sh
TOOLKIT="$(brew --prefix)/share/isonapse/isonapse-adapter-toolkit.tar.gz"   # install.sh: ~/.isonapse/bin/isonapse-adapter-toolkit.tar.gz
(umask 077 && mkdir -p ~/isonapse-codex && cd ~/isonapse-codex && rm -rf isonapse-adapter-toolkit && tar -xzf "$TOOLKIT" \
  && cp isonapse-adapter-toolkit/reference/codex/codex_hook.mjs . \
  && npm install --offline --no-audit --no-fund --ignore-scripts ./isonapse-adapter-toolkit/typescript/isonapse-hook-adk-1.1.0.tgz)
```

   npm installs a copy of the package beside the adapter, so
   `import "@isonapse/hook-adk"` resolves without a registry. An adapter that
   cannot load the package answers every event with an explicit deny. Keep
   `~/isonapse-codex` out of any workspace an agent can write: the
   registration pins `codex_hook.mjs`, not its `node_modules`.

2. Create, validate and register the host profile, then restart:

```sh
isonapse hook host-profile create codex \
  --executable /absolute/path/to/node \
  --script "$HOME/isonapse-codex/codex_hook.mjs" \
  --input-replacement --prompt-boundary > codex-profile.json
isonapse hook host-profile validate codex-profile.json
isonapse hook host-profile register codex-profile.json   # OS authentication
isonapse hook restart
isonapse hook host-profile list                          # copy the full adk-codex-<64 hex> id
```

3. Write the Hook pin file, and read the Hook path Isonapse recorded:

```sh
isonapse hook adk-pin
HOOK="$(sed -n 's/^hook_binary_path = "\(.*\)"/\1/p' ~/.isonapse/config.toml)"; echo "$HOOK"
```

   `isonapse hook adk-pin` verifies the installed Hook that `hook_binary_path`
   names against the signed release manifest installed beside it. Only then
   does it write the SHA-256 of exactly those bytes to an owner-only pin file:
   `<data directory>/adk/hook.sha256`, by default `~/.isonapse/adk/hook.sha256`
   (directory `0700`, file `0600`). It prints:

```text
Verified the installed Hook against its signed release manifest (<N> subjects): <real Hook path>
Pin file: <data directory>/adk/hook.sha256
SHA-256: <64 lowercase hex>
Adapter argument: --hook-sha256-file '<data directory>/adk/hook.sha256'
The hook definition does not change: ADK hosts read the new pin on their next event.
```

   - The first line names the file the Hook path resolves to. On Homebrew that
     path changes with every upgrade, so never put it in `hooks.json`.
   - A Hook or manifest that does not verify is refused, and nothing is
     written. The command never runs automatically.
   - It checks that the data directory is a real directory you own, not the
     directories above it. The ADK applies its full path rule to the pin file
     on every event.
   - A development or install-debug build ships no signed manifest, so
     `adk-pin` refuses it. Only a development build of the CLI accepts
     `--accept-unsigned-local-build`, which pins those bytes without any
     signature check and warns
     `WARNING: pinned an UNSIGNED local build: <path> was not verified against a signed release.`
     The flag never skips a manifest that is present: that manifest is
     always verified. Release installs ship the manifest and never need the
     flag, and a release build of the CLI never pins a Hook without one.

   The registration digest (BLAKE3, computed by `host-profile create`) and this
   SHA-256 pin are different checks; never substitute one for the other.

4. Copy `isonapse-adapter-toolkit/reference/codex/hooks.json` to
   `~/.codex/hooks.json` (merge its six entries if that file exists) and
   replace the placeholders:
   - `__NODE__`: the absolute interpreter path you registered;
   - `__ADAPTER__`: `$HOME/isonapse-codex/codex_hook.mjs`, spelled out;
   - `__HOOK__`: the value of `$HOOK`, verbatim. On Homebrew that is the
     `bin/` link, which the ADK accepts and which stays the same across
     upgrades; never use the path it resolves to;
   - `__HOOK_SHA256_FILE__`: the absolute `Pin file:` path that `adk-pin`
     printed, spelled out. The single quotes stop `~` and `$HOME` from
     expanding, and a relative path is refused with the `pin file invalid`
     cause;
   - `__HOST_ID__`: the full registered id.

   Keep the quotes: qualified Codex normally runs hook commands through its
   resolved local shell with `-c`; its fallback launch uses `$SHELL -lc`. The
   shell's applicable startup files run before the adapter. Codex has no
   per-hook environment setting; operator settings travel in the command
   string. Give the adapter exactly one pin source: a command with both
   `--hook-sha256` and `--hook-sha256-file`, or neither, exits 2 with
   `Isonapse: no usable authorization (Error); the action was not authorized`.

   An inline pin still works: replace `--hook-sha256-file '__HOOK_SHA256_FILE__'`
   with `--hook-sha256 '<pin>'`, where the pin is the output of
   `shasum -a 256 "$HOOK"` (Linux: `sha256sum`). Every upgrade then changes
   the definition, and Codex runs without Isonapse from that edit until you
   re-trust it.

5. Enable Codex hooks and pin Codex's approval reviewer to you in
   `~/.codex/config.toml` (put `approvals_reviewer` above any table):

```toml
approvals_reviewer = "user"

[features]
hooks = true
```

   The adapter denies PermissionRequest events it receives and refuses the
   opt-in `request_permissions` tool at PreToolUse. If a hook gives no answer
   because the adapter never started or timed out, Codex can use its approvals
   reviewer. `"user"` makes that you. A root-written Codex policy
   (`/etc/codex/requirements.toml`) can
   enforce the same with `allowed_approvals_reviewers = ["user"]`; Isonapse
   does not write that file today.

6. Start `codex`, run `/hooks`, review and trust all six definitions.
7. Make one harmless call. In Normal and Enforce mode the first action is the
   cold-start deny (see below); the retry proceeds. Then run
   `isonapse hook report --host adk-codex-…` and `isonapse hook witness verify`.

## After an Isonapse upgrade

Every Isonapse release ships a new Hook binary, so its SHA-256 changes. With
the pin file, `isonapse update` rewrites the pin for you. By hand:

```sh
brew upgrade isonapse             # or re-run install.sh
isonapse hook restart
isonapse hook adk-pin
```

**A stale pin blocks Codex calls that reach the adapter.** The ADK refuses
every event with the `pin mismatch` cause, whose text names
`isonapse hook adk-pin`. The adapter blocks prompts, denies tool calls and
PermissionRequest events and withholds results it receives, and
SessionStart and SessionEnd only log the cause. `codex exec` shows nothing
for a blocked prompt: the turn ends without a model request or a message.
The hook definition does not change, so you do not re-trust it. That Codex
keeps trusting a definition when only the pin file changes was a recorded run
with codex-cli 0.155.1, not a maintained test. Make one harmless call and
confirm with `isonapse hook report --host adk-codex-…` that new receipts
appear.

## When a release changes the adapter

The registered `codex_hook.mjs` is your own copy, so it keeps working after an
upgrade. To take a newer adapter from a release's toolkit, close Codex first,
then:

1. Re-run the step 1 commands without the `cp`, then compare the registered
   adapter with the new one:

```sh
cmp -s ~/isonapse-codex/codex_hook.mjs ~/isonapse-codex/isonapse-adapter-toolkit/reference/codex/codex_hook.mjs && echo unchanged || echo changed
```

   If it is unchanged, stop here. Otherwise copy the new `codex_hook.mjs` into
   `~/isonapse-codex`, repeat step 2 with
   `register --replace codex-profile.json`, and restart. The adapter's bytes
   are part of the host id, so `host-profile list` then shows a new
   `adk-codex-…` id.
2. In all six entries of `~/.codex/hooks.json`, change only `--host` to the
   new id.
3. Start `codex` and run `/hooks` **before any prompt**, and re-trust the six
   definitions. Never run `codex exec` first.
4. Confirm with `isonapse hook report --host …` that new receipts appear.

**Editing the definition opens an ungoverned window.** Codex skips an edited
definition silently, so between the edit and the re-trust every tool runs with
no Isonapse decision and no receipt. This was observed on codex-cli 0.155.1
and is not a maintained test. When `hooks.json` changed 10 minutes or more
ago and no tool decision from the host has been receipted since,
`isonapse hook status --details` and `isonapse hook report --host …` print a warning
that names the re-trust; a session start alone does not clear it, because
Codex appears to review each hook entry on its own (inferred, not a
maintained test). For a profile named `codex…` or registered with
`codex_hook.mjs`, the check reads `$CODEX_HOME/hooks.json`, or
`~/.codex/hooks.json` when `CODEX_HOME` is unset, as the shell that runs
`isonapse hook status --details` sees them: run it with the same `CODEX_HOME` as Codex.
A `hooks.json` whose entries no longer name the host ID still counts, and is
named as such; so do a missing one (timed by its directory; with the
directory gone too, only a note once a tool decision is in the window) and
one Codex cannot read, and a symbolic link counts by its own times as well as
its target's. It is a heuristic, not
a guarantee: confirm new receipts yourself. Changing the Node
interpreter likewise needs `host-profile register --replace`, a restart, the
new host id in all six entries and a re-trust. If the old interpreter or
adapter only moved, restore the registered file to its original path and
restart to use the existing host id.

Never extract the toolkit over the registered `codex_hook.mjs`. The
registration pins that file. If its bytes no longer match, the running
control plane refuses its Hook calls. On restart the control plane starts,
quarantines that profile and keeps other hosts active.

**Moving from the four-entry adapter.** The adapter that answers Codex's own
permission requests and checks prompts is registered with one more flag and
needs two more entries. In step 1 above, also repeat step 2's `create` with
`--input-replacement --prompt-boundary` before `register --replace`: the flag
is part of the host id. Then add the `UserPromptSubmit` and
`PermissionRequest` entries from the new `reference/codex/hooks.json` (with the
same command as the other four), put the new id in all six entries, add
`approvals_reviewer = "user"` to `~/.codex/config.toml` (install step 5) and
re-trust all six definitions before any prompt. Until then the old entries
keep working and the new events are not answered: a prompt goes unchecked and
a permission request goes to Codex's own prompt. Six entries with a profile
created without `--prompt-boundary` block every prompt with
`Reason [prompt-boundary-undeclared]` until you re-register with the flag.

## Moving from an inline pin

A definition that carries `--hook-sha256 '<pin>'` has to be edited after
every upgrade. Move it to the pin file once. The pin file needs this
release's adapter and package (ADK 1.1.0 or later): an older adapter rejects
`--hook-sha256-file` and refuses every event (exit 2). With Codex closed:

1. Re-run the step 1 commands, including the `cp`, then repeat step 2 with
   `register --replace codex-profile.json` and restart. Copy the new host id.
2. Run `isonapse hook adk-pin`.
3. In all six entries, replace `--hook-sha256 '<pin>'` with
   `--hook-sha256-file '<pin file>'` and set `--host` to the new id.
4. Start `codex`, run `/hooks` before any prompt, and re-trust the six
   definitions.
5. Confirm with `isonapse hook report --host …` that new receipts appear.

This one edit opens the ungoverned window once. After it, an upgrade needs
only `isonapse hook restart` and `isonapse hook adk-pin`.

## Uninstall

Remove the six `hooks.json` entries (or disable them in `/hooks`), then
`isonapse hook host-profile remove codex`, `isonapse hook restart`, and
remove `~/isonapse-codex`. The pin file stays in `~/.isonapse/adk/` for any
other ADK host; delete that directory if none uses it.
The authenticated removal command also works while the profile is
quarantined, including when its script is already gone. Restarting clears
it from the quarantine report.

## What the model sees

- Plain allow: Codex runs the exact original input. Without context or an
  operator message, stdout is empty; optional agent context is delivered as
  `additionalContext`, including on an authorized rewrite. Operator messages
  remain in `systemMessage`.
- Rewrite: `permissionDecision:"allow"` with `updatedInput`; Codex runs the
  exact replacement and reports it as the applied input on PostToolUse.
- Deny: `Command blocked by PreToolUse hook: Isonapse: <reason>…
  Command: <cmd>`. For a policy or gate denial the reason is the Hook's display
  text (its `Evidence:` line names the witnessed receipt when one was written);
  never parse it.
- Withheld result: the block reason replaces the tool output.
- Denied permission request: Codex reports the escalation as rejected with
  `Isonapse: Codex's permission request for <tool> is denied: <reason>`; see
  "Codex's own permission requests" below.
- Blocked prompt: the model receives nothing; see
  "Prompt checks" below.

When the ADK cannot use the Hook at all, the adapter denies the tool call
(PreToolUse) or the permission request (PermissionRequest), withholds the
result (PostToolUse), or blocks the prompt (UserPromptSubmit), and the reason
names the cause and no path. `P` stands for
`Installed Hook identity could not be verified`:

| Cause | Reason text |
| --- | --- |
| pin mismatch, pin file | `P (pin mismatch): the Hook binary does not match the SHA-256 in the pin file. After an Isonapse upgrade, run isonapse hook adk-pin; the hook definition does not change.` |
| pin mismatch, inline pin | `P (pin mismatch): the Hook binary does not match the configured SHA-256 pin. After an Isonapse upgrade, recompute the pin from hook_binary_path, update the hook definition and re-trust it.` |
| pin file missing | `P (pin file missing): nothing exists at the configured pin file path. Run isonapse hook adk-pin and use the pin file it names.` |
| pin file invalid | `P (pin file invalid): the pin file path must be absolute and the file must hold exactly one SHA-256 as 64 lowercase hexadecimal characters. Run isonapse hook adk-pin and use the pin file it names.` |
| pin file untrusted | `P (pin file untrusted): <rule>. Run isonapse hook adk-pin and use the pin file it names.`, where the rule is one of the ADK's pin file rules, for example `the pin file is not a regular file owned by you or root and writable only by its owner` |
| untrusted path | `P (untrusted path): <rule>.`, where the rule is one of the ADK's `verify()` rules, for example `the Hook path has more than 8 symbolic links` |
| Hook missing | `P (Hook missing): nothing exists at the configured Hook path; check hook_binary_path in the Isonapse configuration.` |
| changed during verification | `P (changed during verification): the Hook path or file changed while it was being verified, for example during an upgrade.` |
| invalid configuration | `P (invalid configuration): the Hook path must be absolute and the pin must be 64 lowercase hexadecimal characters.` |
| transport or protocol | `Verified Hook could not be started`, `Hook transport failed, …`, `Hook transport budget invalid or operation cancelled`, `Invalid or incompatible Hook Protocol v1 response`, or `Installed Hook version is incompatible with ADK v1` |

On PreToolUse, PermissionRequest and PostToolUse each of these refusals also
travels as `systemMessage`, with the text `Isonapse: <reason>`. On
UserPromptSubmit the block reason is
`Isonapse: <reason>. The prompt was not checked, so it was not sent.`, and it
also goes to the adapter's stderr. SessionStart and
SessionEnd cannot block, so for them the reason goes to the adapter's stderr.
A Hook operator message goes to the adapter's stderr. On a deny, rewrite or
block answer that has none of the causes above, it also travels as
`systemMessage`. A tool mapping refusal carries no `systemMessage`. Whether
Codex shows `systemMessage` or the hook's stderr to you is not proven; the
model sees the deny or block reason.

**First action of every session.** In Enforce mode the coherence gate
cold-starts each session with a durable DEFER. Codex cannot ask a human, so
the daemon converts that DEFER into a witnessed DENY whose receipt names
`can_ask=false` and the cold start; the same happens for the first action
after an Isonapse restart. Only when the Hook itself returned a `deny`
decision for a PreToolUse event, with its durable gate receipt and the reason
class `learned-cold-start`, does the adapter append that this was the
cold-start check and that retrying the same action once proceeds when policy
permits it. A policy denial, including a folder rule's (`file-rule`), stays
denied and carries no note. Nor do identity, transport or protocol refusals,
an `ask` without approval, an `unavailable` decision, a withheld result or a
tool mapping refusal: retrying those does not help. Profile and Normal mode
do not cold-start. An explicit policy `DEFER` is likewise a
witnessed DENY for this host. A permission request carries no retry note:
asking again is denied the same way.

**Repeated SessionStart.** Codex fires SessionStart again for `resume`,
`clear` and `compact` with the same session id. The Hook proves the
session's identity with the session key it keeps, and Isonapse renews the
identity in place, writing one identity receipt. If the Hook no longer holds
that key (removed or replaced, or a different HOME), the start is refused
with the operator warning `failed to bind session identity` and nothing is
minted, also after a restart of the Isonapse control plane; start a new
thread. The proof is only as strong as the protection of that key file.

**A session identity is renewed every 8 hours.** The identity expires 8 hours
after the thread's last SessionStart. From then on every tool call in that
thread is refused before policy runs, in every gate mode including Profile,
with `Reason [session-identity-expired]` and no receipt, until you resume the
thread, which renews it.

## Codex's own permission requests

Codex can ask for approval when an action needs more than its sandbox
allows, such as a command or file change outside the workspace or an MCP tool
that needs approval. For requests Codex sends to its PermissionRequest
hook, an explicit answer bypasses Codex's own reviewer. The adapter denies
every event it receives, including unfamiliar categories:

- It never answers allow, so nothing Isonapse says approves an escalation.
- A running adapter returns an explicit denial so the delivered request
  stops at the hook.
- It asks the Hook first, under the reserved tool name `HostPermissionRequest`
  with Codex's tool name and input. The control plane denies every such
  request in every gate mode, whatever the policy says, and writes one
  witnessed DENY receipt for capability `tool:HostPermissionRequest` with the
  reason `host permission request denied: …`. The model sees
  `Reason [host-permission-request]`, and the `Evidence:` line names the
  receipt.
- If the Hook is older, unavailable or otherwise cannot deny the request,
  the running adapter refuses without a denial receipt.

Codex 0.164.0 disables the `request_permissions` tool by default. When you
enable `request_permissions_tool`, Codex offers the tool and sends ordinary
PreToolUse before its native approval flow. It sends no PermissionRequest
event for this tool. The adapter refuses it before it runs. When the control
plane decides, it records one authorization DENY in every gate mode with
capability `tool:CodexRequestPermissions`. The model sees
`Reason [codex-request-permissions]`. If the Hook cannot make that decision,
the running adapter still refuses without a denial receipt.

What this means:

- For an escalated command that delivers both events, its own PreToolUse
  decision comes first and has its own receipt, often a PERMIT because the
  event carries the command alone. The subsequent PermissionRequest DENY
  stops the escalation.
- `codex exec` never asks: it runs with approvals set to `never`, so Codex
  itself refuses an escalation there and no PermissionRequest fires.
- Codex 0.164.0 asks about network access only when an administrator has set
  a managed network requirement in `/etc/codex/requirements.toml`; without
  one it refuses a host outside its allowlist itself.
- If the adapter never starts or Codex's hook timeout expires, Codex can use
  its own approvals reviewer. Install step 5 sets `approvals_reviewer = "user"`.
  Isonapse records no receipt for that answer.

## Prompt checks

With `--prompt-boundary`, Codex sends every prompt you submit to the Hook
before the model sees it (UserPromptSubmit):

- With `pii_action = "deny_on_ingress"`, a prompt that carries PII is
  blocked: Codex sends nothing to the model, and the reason is
  `Reason [pii-ingress]`. A blocked prompt is not a gate decision and writes
  no authorization receipt. `codex exec` shows nothing for it: the turn ends
  without a model request or a message (codex-cli 0.164.0).
- Otherwise the prompt proceeds unchanged, because Codex cannot rewrite a
  prompt. A PII warning reaches you as `systemMessage`.
- A Codex prompt feeds only this PII check and, when session-purpose capture
  is enabled, the session's purpose record. Unlike a Claude Code or pi prompt,
  it is not registered as the session's stated intent, so intent-deviation
  detection does not compare Codex's later actions with it: Codex cannot ask,
  and a deviation DEFER would reach it as a DENY. Isonapse decides this by
  the host's declared ability to ask (the profile's `--approval`), not by its
  name.
- When the adapter gets no usable answer from the Hook (an identity,
  transport or protocol failure, for example a pin mismatch before
  `isonapse hook adk-pin`), the prompt is blocked and the reason names the
  cause.
- When the Hook runs but cannot check the prompt itself, because its control
  plane is unreachable or its PII check fails, the Hook lets the prompt
  proceed unchanged and the warning says it was not checked, as it does for
  Claude Code. Every tool call is still refused while the control plane is
  unreachable.

Without `--prompt-boundary` the registered id does not accept prompts. If
`~/.codex/hooks.json` still has the `UserPromptSubmit` entry, the Hook blocks
every prompt, whatever it carries, with `Reason [prompt-boundary-undeclared]`,
and no prompt reaches the model unchecked. Re-create the profile with
`--input-replacement --prompt-boundary`, `register --replace`, restart, put
the new id in all six entries and re-trust them.

## The ChatGPT desktop app

The ChatGPT desktop app's Codex workspace reads the same `~/.codex/hooks.json`
and `~/.codex/config.toml` as Codex CLI, so once these hooks are installed and
trusted, they also run for tool calls made in the app. This is **unproven and
unsupported**: the app bundles its own Codex build, which is unqualified (its
version was not determined), and no maintained test drives the app. A tester
using the app saw local tool calls (a web retrieval and an attachment read)
blocked with `ISONAPSE ASK` and `Reason [preparation-refused]`, with no
receipt. Use Codex CLI, at a qualified version where you can. Removing the
six entries from `~/.codex/hooks.json` also removes governance from Codex CLI,
because both read the same file.

## When tool calls are refused with `preparation-refused`

`preparation-refused` and `session-identity-expired` are identity and session
checks that run before policy. Profile mode does not prevent them, and no
receipt is written. Use `isonapse hook doctor --details` to count recent
refusals by class, lists each registered host profile with whether its
interpreter and adapter still match the registration and whether the running
control plane has activated them, and checks
`~/.codex/hooks.json` for host ids no profile has and for Claude-style
entries, which leave Codex ungoverned (see the last rows of the table). The
control plane log records each identity refusal made before
policy with its method, host id (`<unrecognized>` when the id is neither a
known host nor shaped like a registered id) and fixed reason
(`Hook call refused before policy: …`). An expired identity is logged as
`Hook call refused: the session's witnessed root SessionStart identity
expired; …` with its host id, and a refused SessionStart as
`Hook SessionStart refused; no new identity was bound: …`. A repeated
SessionStart (a resume, clear or compact) that proves the session's key
renews the identity in place and is logged only at info level; one that
cannot prove it is a refused SessionStart.

| What you see | Cause | Fix |
| --- | --- | --- |
| Detailed status or doctor shows Codex quarantined, or a call reaching the Hook reports `registered-host-quarantined` | The control plane started without this registration and lists the reason. If the interpreter or script is missing, Codex may be unable to launch the adapter at all | If unused, run `isonapse hook host-profile remove codex`. To use it again, restore the exact registered files at their original paths and run `isonapse hook restart`, or follow the replacement steps above for intentional changes |
| Every call refused with `preparation-refused` saying the control plane did not recognize this caller as a governed host, after you changed the adapter, the interpreter or the toolkit | Identity drift: the registration pins the old interpreter or adapter bytes, and the host id changed with them. `hook doctor --details` reports that the profile's files do not match its registration, or a `hooks.json` host id that no profile has | `isonapse hook host-profile register --replace codex-profile.json`, `isonapse hook restart`, copy the new id from `isonapse hook host-profile list` into `--host` in all six entries, then re-trust them in `/hooks` before any prompt |
| The same refusal while `hook doctor --details` reports that the files match their registration | The files were reinstalled since the control plane started, which `hook doctor --details` reports under `Registered host activation`, or the entries' `--hook` path is not the configured `hook_binary_path` | Run `isonapse hook restart`; check `--hook` against `hook_binary_path` in `~/.isonapse/config.toml` |
| Every call refused with `session-identity-expired` after a long thread | The session's identity expired after 8 hours; Codex renews it only at the thread's next SessionStart | Resume the thread; if the resume warns `failed to bind session identity` (the Hook no longer holds the session's key), start a new thread |
| Tool calls run with no Isonapse decision and no receipt, and `hook doctor --details` warns about entries that run the Hook directly | Claude-style entries (the Hook called without the adapter) copied into `~/.codex/hooks.json`. The Hook answers them with `ask`, which Codex runs, so those calls are not refused: they run without Isonapse (a fail-open state) | Replace them with the six entries from the toolkit's `reference/codex/hooks.json` and re-trust them |
| Refusals only in the ChatGPT desktop app | The app runs the same hooks but is unproven and unsupported | Use Codex CLI, at a qualified version where you can |

## Tool mapping

- `Bash` (`exec_command`, unified exec) arrives as `{"command": …}` and is
  canonical; policy sees `tool:Bash:<boundary>`.
- `apply_patch` arrives as `{"command": "<patch text>"}`. The adapter reads
  the patch exactly as Codex's own parser does: a line ends only at a
  newline, and a header counts after leading whitespace, which Codex trims
  between files and inside Add and Delete File sections. Exactly one
  `*** Add File:` target becomes canonical `Write`, exactly one
  `*** Update File:` target becomes canonical `Edit`, each with the absolute
  `file_path` resolved against the turn cwd and the full patch text bound.
  Delete, Move, multi-target and malformed patches are denied: split the
  patch. So is a patch with a line that a looser reading takes for another
  file header (an indented header inside an Update File section, or one after
  a carriage return or a Unicode line separator), one that names an
  environment, and one whose target starts with whitespace or holds a control
  character or line separator. A rewritten patch is applied only when it
  still names the same file under the same reading.
- A patch run through the shell (`apply_patch <<'EOF' … EOF` in a `Bash`
  command), which Codex applies itself, stays a `Bash` command, and Isonapse
  reads it as a file writer: the files its patch names, read with the same
  header rule, are checked by file rules and self-protection, and a patch it
  cannot read (piped in, read from a file, built by an expansion, an unquoted
  heredoc whose text the shell would expand, a heredoc followed by another
  input redirection, or a header line read two ways) is refused by
  self-protection in every gate mode and by a file rule in Normal and
  Enforce. Codex's own `cd <folder> && apply_patch <<'EOF'` form is placed in
  that folder by self-protection, but a configured file rule refuses it in
  Normal and Enforce, because the file rule check does not follow the folder
  change. Prefer the `apply_patch` tool.
- `mcp__<server>__<tool>` passes through; a replacement replaces the whole
  argument object.
- Other Codex tools pass through under their own name (`tool:<name>`); a
  replacement for them is a deny. `view_image` is one of them: it reaches
  PreToolUse as `{"path": …}`, the path as the model wrote it (often relative
  to the cwd), and a deny blocks it (0.164.0). Its native `path` is a read
  subject for `tool:Read` / `cap:file-read` rules. An absolute path can be
  checked; a relative read is refused in Normal and Enforce when a Read rule
  is configured, because this hook cannot see the tool's working directory.
  Profile records would-deny. Shell read operands use the same rules, and
  opaque interpreter reads are refused conservatively while a Read rule is
  configured. These checks predict visible input; host confinement is still
  needed for the process's actual filesystem effects.

## Boundaries not covered

- `write_stdin` continues an interactive command without a PreToolUse; deny
  bare interpreters and shells in policy if that matters to you.
- Hosted tools (web search) and `Stop`, `Interrupt`, compaction and subagent
  events are not wired. `stop` is not an event a registered profile can send.
  Subagent tool calls (`agent_id` present) are forwarded but were not
  exercised.
- PreToolUse sees only the command string: `workdir`, escalation flags and a
  later hook's rewrite are invisible before the effect. An escalation is
  refused at its PermissionRequest instead, which `codex exec` never sends.
  So a relative path in a shell command, a shell-invoked `apply_patch`'s
  files included, is placed against the session's folder, not the `workdir`
  the command runs in: self-protection checks it there, and a file rule that
  depends on where the file is refuses it.
- An adapter that never starts, or a hook timeout, leaves a permission
  request to Codex's own approval prompt and lets a prompt through unchecked.
- PostToolUse fires for commands that exit non-zero (the result is bound and
  witnessed) but not when Codex itself failed to run the tool.
- `hook status --details` and `hook doctor --details` warn heuristically when a registered
  Codex host may have stopped being governed, including after its hook
  definitions change. A host that runs no hooks leaves no other trace,
  and invoking the registered adapter can clear the warning. Confirm
  receipts after every change; the warning is not a guarantee.

## Proven

- **Adapter against the real daemon, on macOS and Linux.** The real isolated
  daemon, the real Hook and the shipped package, with one fresh adapter
  process per event, in Profile, Normal and Enforce.
- **Pin file across an upgrade.** A maintained test runs the exact hook command
  string through the shell, one process per event, on a Homebrew-shaped
  layout in Enforce mode. After a simulated upgrade, every tool event is
  refused with the pin-file mismatch and no receipt. Then the real
  `isonapse hook adk-pin` re-pins the Hook, governed receipts resume, and the
  hook definition stays byte-identical. This test does not use the real Codex
  binary.
- **Real Codex.** The real `codex exec` binary against a scripted local model
  server with zero credits: the agent honoured a deny, ran an exactly
  rewritten command, never received a withheld secret-bearing result, and its
  SessionEnd hook finished inside Codex's 3 s budget. Two negatives run the
  same binary against the same `hooks.json`: without persisted hook trust and
  without the bypass flag every scripted command runs and the daemon writes no
  receipt; with `--ignore-user-config` the definitions still load and the run
  is governed. Recorded runs: codex-cli 0.164.0 on macOS arm64 and Linux x86_64 with Codex's sandbox active (the qualified version), and the
  same tests on the VS Code extension's bundled `0.164.0-alpha.11.1` build on
  Linux arm64.
- **Codex's own permission requests and the prompt veto, real Codex.** On
  codex-cli 0.164.0 on macOS arm64 and Linux x86_64,
  `codex app-server` with a client that
  approves everything: a command outside the sandbox, a file change outside
  the workspace and an MCP tool that needs approval are each denied with one
  witnessed DENY, and no approval reaches the client. `codex exec` sends
  nothing to the model for a prompt the Hook blocks. That permission-request
  test does not exercise managed network access, elevated stdin or the
  opt-in `request_permissions` tool.
- **Not proven:** the ChatGPT desktop app's Codex
  workspace, which runs the same `~/.codex` hooks; a hosted-model install on
  macOS; subagents;
  receipts across an upgrade and re-pin with the real Codex binary; the
  un-trust of an edited definition and the kept trust of a changed pin file
  (both observed on 0.155.1); unqualified Codex versions; and Windows, where
  the ADK has no transport.
