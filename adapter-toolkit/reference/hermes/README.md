# Hermes reference glue

> **Status — Public beta:** Reference source for the shipped Hermes integration.

`isonapse/__init__.py` is the shipped host-side plugin and `plugin.yaml` is its
Hermes registration. It invokes the cohort-bound installed
`isonapse-hermes-adapter`; the Rust adapter and proprietary hook binary are not
part of this toolkit.

`_adk_json.py` is the unchanged strict JSON decoder from the Python ADK. The
installer includes and verifies it with the plugin; the native-boundary tests
load the same canonical package source. Duplicate keys and nonfinite values
cannot be interpreted as a last-key-wins permission or unscanned result.

Hermes currently provides a reliable pre-tool refusal boundary and lifecycle
callbacks, but no trusted final model-output perimeter. The registered
`hermes` profile therefore does not claim output rewriting or native ask.

Use this as a compact example of bounded subprocess handling, identity
capture, exact instruction validation, and fail-closed exception handling.
Installation is performed by `isonapse hook init --host hermes`.

Self-protection covers profile selection (`active_profile` and `profiles/`) as
well as the plugin/configuration roots. Creating or switching profiles requires
an operator terminal outside the governed session. Install Isonapse in the selected
profile, start a fresh session and run `isonapse hook status` with the same
`HERMES_HOME`. Status resolves the active runtime profile; doctor lists disk paths
and reports that active runtime selection is unknown without executing Hermes.

Optional agent context is queued for the same session's next user-turn
`pre_llm_call`, labeled as context from a previous governed tool decision and
consumed once. A healthy tool decision or session start/end/finalize clears it.
The process-local queue holds at most 64 sessions and 64 KiB per session; a
plugin restart clears it. Operator-only warnings never enter that queue.
Optional delivery failures preserve an authorization; malformed known context
is refused. Use `isonapse hook status` for current policy-load diagnostics.

The plugin reports two folders. `cwd` is Hermes's own process folder, where
Hermes loads project plugins. `tool_cwd` is the folder Hermes runs the tool
in: for `terminal`, the session folder Hermes records after each `cd` (the
Hook reads a call's own `workdir` from the call); for the file tools, the
folder Hermes resolves their relative paths in. The plugin reads both from the
pinned Hermes runtime on its local backend. When it cannot, it sends no
`tool_cwd`, and Isonapse's self-protection then refuses a relative write
target or file-tool path unchecked instead of guessing its folder. Input sent
to a background process through the `process` tool is checked as a shell
command whose folder is unknown.

The plugin carries no credential of its own. The control plane authenticates
each adapter call by the Hermes process that started it, so Hermes must run in
a recognized launch shape: the `hermes` executable, the `hermes` console
script that pipx, `uv tool install` or a venv places on `PATH` (a Python
interpreter running `<prefix>/bin/hermes`), or a source checkout run as
`python -m hermes_cli`. A renamed or look-alike wrapper (`hermes-notes`,
`hermes.py`, the `hermes-agent` runner) is refused; every tool call then fails
closed with `preparation-refused` and `isonapse hook doctor` reports the
refusal as unauthenticated Hook ingress.
