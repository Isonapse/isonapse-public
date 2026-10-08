# Isonapse Hook ADK for TypeScript / JavaScript

> **Status — Public beta:** Ships as a packed package in current Agent Hook
> release archives; it is not published to the npm registry.

This package implements Hook Adapter Protocol v1 for Node.js 22 or later on
macOS and Linux. ESM JavaScript and TypeScript declarations are included, with
no runtime dependencies. Windows transport is not implemented.

## Install

Current Agent Hook release archives carry the adapter toolkit,
`isonapse-adapter-toolkit.tar.gz`: with Homebrew at
`$(brew --prefix)/share/isonapse/`, with `install.sh` next to the installed
binaries (by default `~/.isonapse/bin/`). Extract it and install the packed
package from your project directory, offline:

```sh
tar -xzf "$(brew --prefix)/share/isonapse/isonapse-adapter-toolkit.tar.gz"
npm install --offline --no-audit --no-fund --ignore-scripts \
  ./isonapse-adapter-toolkit/typescript/isonapse-hook-adk-1.1.0.tgz
```

npm installs a copy and records the tarball's integrity in your lockfile.
Upgrade by installing the package from a newer release's toolkit; remove it
with `npm uninstall @isonapse/hook-adk`.

## API

Import `Client`, `InstalledHook`, `execute`, `deliver`, `Unavailable` and
`Refused` from `@isonapse/hook-adk`.

`npx --no-install isonapse-hook-adk init agent.mjs` creates a non-overwriting
native Read starter. The starter takes an inline pin (`--hook-sha256`); to
read the pin from a pin file instead, construct the Hook with
`InstalledHook.fromPinFile`. Register the reviewed executable/script as described in
`HOST-PROFILES.md`. Import `Runtime` from `@isonapse/hook-adk/runtime` for
`start()`, `tool(callId, canonicalName, arguments, nativeCallback)` and `end()`.
This helper snapshots input and output around asynchronous checks, reports the
actual applied input, and never repeats the native effect on completion failure.
Callbacks return bounded JSON, not arbitrary class instances or streams.

- `new InstalledHook(absolutePath, trustedSha256)` never searches PATH. Pass
  the Hook path that Isonapse recorded as `hook_binary_path` (a Homebrew `bin/`
  link is supported). Obtain the pin independently from the approved
  installation, not from a model/event or an untrusted download.
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
  - The installation owner and root remain trusted against concurrent
    replacement.
- The pin can come from a pin file instead:
  `InstalledHook.fromPinFile(path, pinFile)`.
  - The file is read on every `verify()`.
  - It must be named by an absolute path, must not itself be a link, must be
    owned by you or root and writable only by its owner, must sit in
    directories that pass the rule above, and must hold exactly 64 lowercase
    hexadecimal characters with at most one trailing newline.
  - The causes are `hook-identity:pin-file-missing`, `-untrusted` and
    `-invalid`. A stale pin file is `hook-identity:pin-mismatch`, and its text
    names `isonapse hook adk-pin`.
  - Give exactly one pin source.
  - `isonapse hook adk-pin` writes the file after verifying the Hook against
    its signed release manifest. Rerun it after every Isonapse upgrade; the
    host's hook definition does not change.
- `new Client(installed, registeredHostId, {timeoutMs: 50000})` freezes invocation
  configuration. `await client.checkVersion()` checks startup compatibility.
- `await client.decide(event, request, {boundary, signal})` validates Protocol v1.
  Boundary is `pre`, `post` or `lifecycle`. Native session and tool-call IDs must
  be stable, trusted and preserved through completion. Errors never imply allow.
- `await execute(decision, originalInput, nativeEffect, {approve})` applies the
  exact replacement object without restoring removed keys. Deny/unavailable or
  unsuccessful approval do not call the effect. Decisions from another boundary
  cannot authorize it.
- `deliver(decision, originalOutput)` returns only a permitted post-action output
  or replacement; otherwise it throws `Refused`.

Decoded decisions are single-use, including concurrent `execute` calls. Nested
rewrite payloads are immutable. Low-level users must snapshot original input
before `decide` and retain the exact output snapshot submitted for scanning;
do not execute/deliver an object that changed during an asynchronous check.

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
| `hook-transport` | The verified Hook could not be started, its transport failed, or the transport budget was invalid or cancelled. |
| `hook-protocol` | The Hook answered with an invalid or incompatible Protocol v1 response or version. |

Surface `operatorMessage` to the operator. Do not parse reason strings. Human
approval is a host action, not proof of an Isonapse receipt. Report the actual
applied input, outcome and same call ID at completion; never retry a tool effect
to retry its completion. Capabilities the native host cannot enforce must be
declared unavailable, not implemented by ignoring required rewrites or approval.

Requests/responses are bounded at 1 MiB, stderr at 64 KiB, transport at 50 seconds.
Abort/timeout kills the Hook process group and closes local streams independently
of escaped pipe holders. This cannot terminate independently detached processes
outside the group. Transport errors do not expose raw subprocess diagnostics.

In the toolkit's source tree, `npm test` runs the real exported library against
explicitly pinned subprocess protocol fixtures. Those tests are distinct from
live daemon/receipt conformance.

## Hook-command hosts

`@isonapse/hook-adk/hook-command` serves hook-command hosts: runtimes such as
OpenAI Codex CLI hooks that start one fresh adapter process per native event,
hand it one JSON event on stdin and read a host-shaped answer, so `Runtime`
(pre, effect and post inside one call) does not fit. `readHostEvent(stdin)`
reads one bounded, strictly decoded event (1 MiB, valid UTF-8, no duplicate
keys, an object). `hookCommand(client, event, {approve, checkVersion, signal})`
takes a canonical event (`hook_event_name` of `SessionStart`, `SessionEnd`,
`PreToolUse` or `PostToolUse` with `session_id`, `cwd`, and `tool_use_id`,
`tool_name`, `tool_input`, `tool_response` as applicable), forwards only those
canonical fields to the Hook, and returns a frozen outcome whose `kind` is the
only field to branch on: lifecycle `acknowledged`/`refuse`; pre-action
`proceed` (run the exact original input), `rewrite` (run exactly `input`) or
`refuse`; post-action `deliver`, `replace` (show exactly `output`) or
`withhold`. Transport failure and every refusal are outcomes, never allows;
an unsupported or malformed event throws before the Hook runs. An outcome
caused by an `Unavailable` carries its `code` as `cause`, so the adapter can
tell an identity, transport or protocol failure from a policy decision.
Without an `approve` callback an `ask` is a refusal. The adapter renders the
host's wire format itself and must answer every path explicitly when its host
fails open on a silent or crashed hook; `reference/codex/` is the maintained
example. `decodeHostEvent(bytes)` from the main entry applies the same strict
decoding to bytes a host delivered another way.

`replaceExecutableInput` from `@isonapse/hook-adk/input` supports hosts such as
Pi whose execution seam requires in-place replacement. It returns an error
string if it cannot remove every old key and install the exact replacement;
abort execution on that error. Pi's maintained tests exercise this same helper.
The installer embeds the unchanged helper into Pi's integrity-checked extension.

If a native effect returns oversized or non-JSON output, the runtime reports
completion unknown and withholds the result. Do not retry the effect.

Licensed under Apache-2.0; see LICENSE.
