# pi reference glue

> **Status — Public beta:** Reference source for the shipped pi integration.

`isonapse.ts` is the maintained pi extension source. Its exact input-replacement
helper comes from `@isonapse/hook-adk/input`; install the pinned toolkit's
`typescript/` package when developing this reference. The Isonapse installer
embeds that exact helper source in the integrity-checked single extension, so
the installed runtime does not resolve an ambient npm dependency. It invokes the cohort-bound
installed `isonapse-pi-adapter`; the Rust adapter and proprietary hook binary
are not part of this toolkit.

The registered `pi` profile covers input rewrite, output rewrite, and native
ask. The extension replaces pi's executable input object in place and verifies
the replacement, so removed keys cannot survive as unauthorized arguments.

Installation is performed by `isonapse hook init --host pi`.

## Rendered values

This source carries two placeholders that `isonapse hook init --host pi`
replaces, each exactly once, when it installs the extension:

- `/__ISONAPSE_PI_ADAPTER_PATH_MUST_BE_RENDERED__/isonapse-pi-adapter` becomes
  the path of the installed, cohort-bound `isonapse-pi-adapter`.
- `"__ISONAPSE_PI_QUALIFIED_VERSIONS_MUST_BE_RENDERED__"`, the value of
  `RENDERED_QUALIFIED_PI_VERSIONS`, becomes the JSON list of the pi releases the
  installing Isonapse release qualified (currently pi 1.0.3 and 1.0.4).

The extension reads the running pi's own `VERSION` when it loads. Unless that
version is exactly one of the rendered releases, every tool call is refused
before the adapter is asked, in every gate mode, and pi shows the reason once
per session. An unrendered copy, such as this reference file, carries no
qualified releases, so it refuses every tool call. This refusal is made locally
by the extension inside pi: it is not a gate decision, and the refused call has
no receipt. pi reads the version it reports from its own `package.json`, or
from the directory `PI_PACKAGE_DIR` names, so while `PI_PACKAGE_DIR` is set to
anything but the running pi's own package directory the version cannot be
verified and every tool call is refused the same way. The check runs inside the
extension, so it covers a pi that still loads the extension and delivers tool
calls to it.

## Supported pi version

The shipped integration supports only the exactly qualified pi releases,
currently pi 1.0.3 and 1.0.4. The list is exact, not a minimum or a range: the
installer refuses every other pi version by design until it is qualified,
including pi 0.80.2 and every other 0.x release, and stops before writing
anything. Install the newest qualified release with npm, which pins the exact
version, and confirm it before running init:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.4
pi --version   # must print 1.0.3 or 1.0.4
```

`pi update` and the pi.dev installer always install the newest pi release,
which may be refused until it is qualified.

A project-scoped install also needs pi's saved `/trust` decision for the
folder. Pi keeps those decisions per agent directory (`PI_CODING_AGENT_DIR`,
default `~/.pi/agent`), so save the trust, run the installer, and start pi with
the same `PI_CODING_AGENT_DIR`. That trust also lets pi load the project's
`.pi/mcp.json`; pi starts the configured MCP servers at session start, outside
the Isonapse gate, while each MCP tool call is still gated.
