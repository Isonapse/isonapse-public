# Integration guide

1. Install the pinned candidate's `python/` or `typescript/` package following
   its README. Create a native starter with `python -m isonapse_hook_adk init
   agent.py` or `isonapse-hook-adk init agent.mjs`. `template/` is a synthetic
   test host, not production execution glue.
2. Map only trusted host callback fields. Session/tool-call identity and cwd
   must come from the runtime context, never model-authored tool arguments.
3. Install the decision at the host's execution seam. Exact replacement must
   affect the object the host actually executes or shows to the model. For a
   hook-command host (one fresh adapter process per event, such as OpenAI
   Codex CLI hooks) the seam is the answer the host reads from the adapter's
   stdout and exit status: use the packages' `hook-command` helper, render the
   host's wire format yourself, and study `reference/codex/`.
4. Run the package tests and the complete applicable conformance suite. Declare
   only capabilities the native API can prove. Follow `HOST-PROFILES.md` to
   register the exact interpreter and entrypoint, then restart through the
   authorized lifecycle command. Registration is not an automatic restart.
5. Supply the ADK the recorded `hook_binary_path` (a Homebrew link is
   supported) and an independently trusted SHA-256 pin. The ADK resolves that
   path, checks the file it reaches and runs that resolved file. Do not select
   security code from ambient `PATH`, model arguments, or a mutable
   per-process environment variable. The registration
   digest uses BLAKE3; the ADK installation pin uses SHA-256. They are different
   checks and must not be substituted for each other.

   Prefer a pin file. Run `isonapse hook adk-pin` on the machine that runs the
   Hook. It verifies the installed Hook that `hook_binary_path` names against
   the signed release manifest installed beside it and only then writes the
   SHA-256 of exactly the verified bytes to an owner-only pin file,
   `<data_dir>/adk/hook.sha256` (by default `~/.isonapse/adk/hook.sha256`;
   directory `0700`, file `0600`). It prints the pin file and the exact adapter
   argument, `--hook-sha256-file '<pin file>'`. In code, use
   `InstalledHook.fromPinFile(path, pinFile)` (TypeScript) or
   `InstalledHook.from_pin_file(path, pin_file)` (Python). The ADK reads the pin
   file on every event. The pin file must be named by an absolute path, must not
   itself be a link, must be owned by you or root and writable only by its
   owner, must sit in directories that pass the Hook path rule, and must hold
   exactly 64 lowercase hexadecimal characters with at most one trailing
   newline. Anything else is refused with a `pin-file-missing`,
   `pin-file-untrusted` or `pin-file-invalid` identity cause whose text names
   `isonapse hook adk-pin`. A development or install-debug build ships no
   signed manifest: `adk-pin` refuses it unless a development build of the CLI
   is given `--accept-unsigned-local-build`, which pins those bytes without
   any signature check. The command never runs automatically.

   An inline pin (`--hook-sha256`, `new InstalledHook(path, sha256)`) still
   works. Compute it from the installed Hook binary that `hook_binary_path` in
   `~/.isonapse/config.toml` names, on the machine that runs it:

   ```sh
   shasum -a 256 "$(sed -n 's/^hook_binary_path = "\(.*\)"/\1/p' ~/.isonapse/config.toml)"
   ```

   Store that value in your adapter's operator-controlled configuration (a
   hook-command host carries it in the hook command string). A pin copied from
   a model message, a download page or another machine is not independently
   trusted. Give the ADK exactly one of the two pin sources.
6. If the host runs the tool when a hook crashes, times out, cannot be started
   or answers in an unsupported shape, it is a cooperative fail-open host.
   Answer every path explicitly, keep the adapter's own deadline below the
   host's, keep interpreter and adapter paths stable, and say so in your host
   documentation. See the checklist in `README.md`.

The generated starter performs a bounded native file read. Replace its callback
with your host's native tool implementation, retaining the canonical name,
trusted call identity and applied-input/completion pairing. Noninteractive
starters refuse ASK; supply a real operator approval callback only if your host
has that capability. Never automatically approve to make a smoke test pass.

## Production smoke test

Start Isonapse, trigger one harmless tool call, and inspect the session with
the supported Isonapse CLI:

```sh
isonapse hook report --host <registered-host-id>
isonapse hook witness verify
isonapse hook witness query
```

A successful integration has both sides:

- the host ran the authorized input (including any rewrite); and
- the session shows the matching gate decision and authorization receipt.

An unavailable response establishes no usable authorization; that action must
not run. An adapter log or a conformance pass is not receipt proof. Test deny
and daemon-unavailable paths too, and confirm neither executes the original
input. On a fail-open host, also confirm that the host itself honoured a deny
(the model saw the block, the tool never started) and that the adapter's
explicit refusal, not a crash, is what the host received when the daemon was
stopped. A later completion failure cannot undo an effect. The ADK withholds
unusable results and never repeats the effect; an oversized or non-JSON native
result explicitly reports completion unknown rather than inventing a receipt.

## Updating

Run the suite again whenever the host, adapter, or hook changes. The public
repository records the exact private release-candidate SHA and Git blob for
every toolkit file in `.isonapse-support-source.json`; use that provenance to
pin reviews. Protocol additions require a new advertised version. V1 readers
tolerate extra fields but never guess at a different version.

### After an Isonapse upgrade

Every Isonapse release ships a new Hook binary, so its SHA-256 changes with
every upgrade. Until the pin is updated, the ADK refuses every event with the
`pin mismatch` cause. The reference Codex adapter denies every tool call and
withholds every result, and SessionStart and SessionEnd only log the cause:
the host's tool calls are blocked, not ungoverned.

With a pin file (step 5, recommended):

1. Upgrade (`brew upgrade`, or the install script), then run
   `isonapse hook restart`.
2. Run `isonapse hook adk-pin`. It verifies the new Hook against its signed
   release manifest and rewrites the pin file. Until then every event is
   denied with the `pin mismatch` cause, whose text names this command.
3. Confirm with one harmless action that `isonapse hook report --host <id>`
   shows a new receipt from the upgraded build.

The hook definition never changes, so a host that keys its hook trust on the
definition keeps trusting it and there is no ungoverned window. Codex keys
trust on the definition, not on files its command reads: with codex-cli
0.155.1, changing only the pin file kept the definition trusted, while editing
the definition string un-trusted it (a recorded real-Codex run, not a
maintained test).

With an inline pin:

1. Recompute the pin with the command in step 5 and update the adapter's
   configuration with it.
2. For a hook-command host whose settings travel in the command string, the
   hook definition itself changes. Codex, for example, un-trusts an edited
   definition (observed on codex-cli 0.155.1, not a maintained test) and
   silently skips it until you review and re-trust it in its `/hooks`
   command; until then Codex runs without Isonapse. That an untrusted
   definition is skipped, with the tool running and no receipt written, is a
   maintained test in the Codex reference lane. Re-trust immediately after
   editing. This is the ungoverned window that a pin file removes.
3. Confirm as above.

Moving an existing setup from an inline pin to a pin file edits the hook
definition once, so it opens that window once. Run `isonapse hook adk-pin`,
close the host, replace `--hook-sha256 '<pin>'` with
`--hook-sha256-file '<pin file>'` in every hook entry, then start the host and
re-trust the definition (Codex: `/hooks`) before any prompt.

The BLAKE3 registration digest does not change on an Isonapse upgrade; it
changes only when the interpreter or adapter bytes change, which requires
`host-profile register --replace` and a restart. Until you re-register, the
daemon refuses an adapter whose bytes differ from the registered pin, and the
adapter reports that refusal as a deny.

Use public issues for adapter bugs and profile proposals. Redact receipts,
paths, prompts, and host payloads. Send vulnerabilities privately to
`security@isonapse.com`.
