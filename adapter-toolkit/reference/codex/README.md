# OpenAI Codex CLI reference adapter

> **Status — Public beta:** Ships in current Agent Hook release archives.
> Proven only with the codex-cli versions in
> `supported-versions.json` (today 0.155.1). Codex is a cooperative, fail-open
> host.

`codex_hook.mjs` is a complete hook-command host adapter: Codex starts one
fresh process per hook event, writes one JSON event to its stdin and reads the
decision from stdout and the exit status. The adapter uses the shipped
`@isonapse/hook-adk` package (`Client`, `hook-command`); it copies no transport.
`hooks.json` is the Codex hook definition template.

## Supported Codex versions

`supported-versions.json` is the list of exact codex-cli versions on which a
real Codex run has proven this adapter; the lowest one is the floor. Today
that is 0.155.1 only. A version above the floor that is not on the list is
unproven, not supported: Codex's hook contract changes between releases, and
on a fail-open host a changed contract can mean ungoverned tool calls. The
adapter does not check the Codex version at runtime. Check `codex --version`
(it prints `codex-cli <version>`) before you rely on it, and after every Codex
update.

## Capability boundary (declare exactly this)

| Isonapse capability | Codex 0.155.1 | Adapter behaviour |
| --- | --- | --- |
| Pre-action refusal | yes | JSON `permissionDecision:"deny"` with a non-empty reason; every failure path answers explicitly |
| Input replacement | yes for `Bash` (`command`), `apply_patch` (patch text) and MCP tools (whole argument object) | `--input-replacement`; a replacement the host cannot apply exactly is a deny |
| Approval (`ask`) | **no**: Codex parses `ask` but does not support it and lets the tool run | never declared; an `ask` is a deny |
| Output replacement | **no exact replacement**: PostToolUse can only withhold a result | never declared; any required replacement or refusal is `decision:"block"` |
| Prompt boundary | not wired | not declared |
| Lifecycle | SessionStart, SessionEnd (advisory, 1-3 s budget) | acknowledged; cannot block |

Register the profile with `--input-replacement` only. Codex keeps the raw
tool result when a PostToolUse hook withholds it; the model sees the block
reason instead. A withheld result does not undo the side effect.

**Codex is a cooperative, fail-open host.** A hook that crashes, times out,
prints invalid JSON, answers `ask`, answers `allow` without `updatedInput`, or
cannot be spawned (missing Node, wrong path) lets the tool run. The adapter
converts every failure it can see into an explicit deny (exit 2 with a
non-empty stderr from its outermost handler), but it cannot help if it never
starts. Its own deadlines stay below the template's 60 s timeouts so that it,
not Codex, answers on a hung daemon: one 50 s exchange for a tool event, and
two 25 s exchanges (version probe, then decision) for SessionStart.

A hook definition Codex has not been told to trust is silently skipped, which
means an ungoverned Codex. A maintained test shows it: the real `codex exec`
runs this `hooks.json` without persisted trust and without the bypass flag,
every scripted command runs, and the daemon writes zero receipts. That test
needs a real codex binary, so it does not run in every automated release
check. Codex keys its trust on the definition, not on the files its command
reads. With codex-cli 0.155.1, editing a trusted definition returned it to the
untrusted state, and changing only the pin file the command names kept it
trusted (a recorded run). Neither is a maintained test. Read the Hook pin from
the pin file (below), keep the interpreter and adapter paths stable, and
re-trust after every edit of the definition.

## Prerequisites

- A working Agent Hook: `isonapse hook status` is healthy, on a release that
  ships the adapter toolkit and `isonapse hook adk-pin`.
- A supported codex-cli (see above).
- Node.js 22 or newer at a canonical path that only you or root can change: a
  non-symlink regular file owned by you or root and not group- or
  world-writable, whose parent directories are each owned by you or root and
  not group- or world-writable (a root-owned sticky-bit directory such as
  `/tmp` is tolerated); for example a version manager's real `.../bin/node`,
  never a shim script. `HOST-PROFILES.md` states the rule in full;
  `host-profile create` refuses Homebrew's `node` and framework paths that
  fail it.

## Install

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
  --input-replacement > codex-profile.json
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
   `~/.codex/hooks.json` (merge its four entries if that file exists) and
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

   Keep the quotes: Codex runs the command through `$SHELL -lc`. Codex has no
   per-hook environment setting; operator settings travel in the command
   string. Give the adapter exactly one pin source: a command with both
   `--hook-sha256` and `--hook-sha256-file`, or neither, exits 2 with
   `Isonapse: no usable authorization (Error); the action was not authorized`.

   An inline pin still works: replace `--hook-sha256-file '__HOOK_SHA256_FILE__'`
   with `--hook-sha256 '<pin>'`, where the pin is the output of
   `shasum -a 256 "$HOOK"` (Linux: `sha256sum`). Every upgrade then changes
   the definition, and Codex runs without Isonapse from that edit until you
   re-trust it.

5. Enable Codex hooks in `~/.codex/config.toml`:

```toml
[features]
hooks = true
```

6. Start `codex`, run `/hooks`, review and trust all four definitions.
7. Make one harmless call. In Normal and Enforce mode the first action is the
   cold-start deny (see below); the retry proceeds. Then run
   `isonapse hook report --host adk-codex-…` and `isonapse hook witness verify`.

## After an Isonapse upgrade

Every Isonapse release ships a new Hook binary, so its SHA-256 changes. With
the pin file:

```sh
brew upgrade isonapse             # or isonapse-beta / isonapse-alpha, or re-run install.sh
isonapse hook restart
isonapse hook adk-pin
```

**Until `adk-pin` has run, Codex is blocked, not ungoverned.** The ADK refuses
every event with the `pin mismatch` cause, whose text names
`isonapse hook adk-pin`; the adapter denies every tool call and withholds
every result, and SessionStart and SessionEnd only log the cause.
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
2. In all four entries of `~/.codex/hooks.json`, change only `--host` to the
   new id.
3. Start `codex` and run `/hooks` **before any prompt**, and re-trust the four
   definitions. Never run `codex exec` first.
4. Confirm with `isonapse hook report --host …` that new receipts appear.

**Editing the definition opens an ungoverned window.** Codex skips an edited
definition silently, so between the edit and the re-trust every tool runs with
no Isonapse decision and no receipt. This was observed on codex-cli 0.155.1
and is not a maintained test. Isonapse does not warn you when this happens;
the only sign is that `hook report` shows no new receipts. Changing the Node
interpreter likewise needs `host-profile register --replace`, a restart, the
new host id in all four entries and a re-trust.

Never extract the toolkit over the registered `codex_hook.mjs`: the
registration records that file's identity, and until you re-register the
daemon refuses the adapter, which then answers every event with a deny.

## Moving from an inline pin

A definition that carries `--hook-sha256 '<pin>'` has to be edited after
every upgrade. Move it to the pin file once. The pin file needs this
release's adapter and package (ADK 1.1.0 or later): an older adapter rejects
`--hook-sha256-file` and refuses every event (exit 2). With Codex closed:

1. Re-run the step 1 commands, including the `cp`, then repeat step 2 with
   `register --replace codex-profile.json` and restart. Copy the new host id.
2. Run `isonapse hook adk-pin`.
3. In all four entries, replace `--hook-sha256 '<pin>'` with
   `--hook-sha256-file '<pin file>'` and set `--host` to the new id.
4. Start `codex`, run `/hooks` before any prompt, and re-trust the four
   definitions.
5. Confirm with `isonapse hook report --host …` that new receipts appear.

This one edit opens the ungoverned window once. After it, an upgrade needs
only `isonapse hook restart` and `isonapse hook adk-pin`.

## Uninstall

Remove the four `hooks.json` entries (or disable them in `/hooks`), then
`isonapse hook host-profile remove codex`, `isonapse hook restart`, and
remove `~/isonapse-codex`. The pin file stays in `~/.isonapse/adk/` for any
other ADK host; delete that directory if none uses it.

## What the model sees

- Plain allow: nothing (empty stdout). Codex runs the exact original input.
- Rewrite: `permissionDecision:"allow"` with `updatedInput`; Codex runs the
  exact replacement and reports it as the applied input on PostToolUse.
- Deny: `Command blocked by PreToolUse hook: Isonapse: <reason>…
  Command: <cmd>`. For a policy or gate denial the reason is the Hook's display
  text (its `Evidence:` line names the witnessed receipt when one was written);
  never parse it.
- Withheld result: the block reason replaces the tool output.

When the ADK cannot use the Hook at all, the adapter denies the tool call
(PreToolUse) or withholds its result (PostToolUse), and the reason names the
cause and no path. `P` stands for `Installed Hook identity could not be
verified`:

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

On PreToolUse and PostToolUse each of these refusals also travels as
`systemMessage`, with the text `Isonapse: <reason>`. SessionStart and
SessionEnd cannot block, so for them the reason goes to the adapter's stderr.
A Hook operator message goes to the adapter's stderr. On a deny, rewrite or
block answer that has none of the causes above, it also travels as
`systemMessage`. A tool mapping refusal carries no `systemMessage`. Whether
Codex shows `systemMessage` or the hook's stderr to you is not proven; the
model sees the deny or block reason.

**First action of every session.** In Normal and Enforce mode the coherence
gate cold-starts each session with a durable DEFER. Codex cannot ask a human,
so the daemon converts that DEFER into a witnessed DENY whose receipt names
`can_ask=false`; the same happens for the first action after an Isonapse
restart. Only when the Hook itself returned a `deny` decision for a
PreToolUse event does the adapter append that a first-action denial is the cold-start check and
that retrying the same action once proceeds when policy permits it, while a
policy denial stays denied. The note is not added to identity, transport or
protocol refusals, an `ask` without approval, an `unavailable` decision, a
withheld result or a tool mapping refusal: retrying those does not help.
Profile mode does not cold-start. An explicit policy `DEFER` is likewise a
witnessed DENY for this host.

**Repeated SessionStart.** Codex fires SessionStart again for `resume`,
`clear` and `compact` with the same session id. The Hook returns allow with
an operator warning (`failed to bind session identity`) and writes no receipt;
the live session keeps working with its original identity.

## Tool mapping

- `Bash` (`exec_command`, unified exec) arrives as `{"command": …}` and is
  canonical; policy sees `tool:Bash:<boundary>`.
- `apply_patch` arrives as `{"command": "<patch text>"}`. Exactly one
  `*** Add File:` target becomes canonical `Write`, exactly one
  `*** Update File:` target becomes canonical `Edit`, each with the absolute
  `file_path` resolved against the turn cwd and the full patch text bound.
  Delete, Move, multi-target and malformed patches are denied: split the
  patch. A rewritten patch is applied only when it still names the same file.
- `mcp__<server>__<tool>` passes through; a replacement replaces the whole
  argument object.
- Other Codex tools pass through under their own name (`tool:<name>`); a
  replacement for them is a deny.

## Boundaries not covered

- `write_stdin` continues an interactive command without a PreToolUse; deny
  bare interpreters and shells in policy if that matters to you.
- Hosted tools (web search) and `PermissionRequest`, `Stop`, `Interrupt`,
  compaction and subagent events are not wired. `stop` is not an event a
  registered profile can send. Subagent tool calls (`agent_id` present) are
  forwarded but were not exercised.
- The hook sees only the command string: `workdir`, escalation flags and a
  later hook's rewrite are invisible before the effect.
- PostToolUse fires for commands that exit non-zero (the result is bound and
  witnessed) but not when Codex itself failed to run the tool.
- Nothing warns you when a registered Codex host stops being governed, for
  example after an edit of its definitions left them untrusted (observed on
  codex-cli 0.155.1, not a maintained test).

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
- **Real Codex, on macOS only.** The real `codex exec` binary (codex-cli
  0.155.1) against a scripted local model server with zero credits: the agent
  honoured a deny, ran an exactly rewritten command, never received a withheld
  secret-bearing result, and its SessionEnd hook finished inside Codex's 3 s
  budget. Two negatives run the same binary against the same `hooks.json`:
  without persisted hook trust and without the bypass flag every scripted
  command runs and the daemon writes no receipt; with `--ignore-user-config`
  the definitions still load and the run is governed.
- **Not proven:** the real Codex binary on Linux; hosted models; subagents;
  receipts across an upgrade and re-pin with the real Codex binary; the
  un-trust of an edited definition and the kept trust of a changed pin file
  (both observed on 0.155.1); Codex versions not listed in
  `supported-versions.json`; and Windows, where the ADK has no transport.
