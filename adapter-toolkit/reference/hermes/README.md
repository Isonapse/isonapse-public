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

Use this as a compact example of bounded subprocess handling, trusted cwd and
identity capture, exact instruction validation, and fail-closed exception
handling. Installation is performed by `isonapse hook init --host hermes`.

The plugin carries no credential of its own. The control plane authenticates
each adapter call by the Hermes process that started it, so Hermes must run in
a recognized launch shape: the `hermes` executable, the `hermes` console
script that pipx, `uv tool install` or a venv places on `PATH` (a Python
interpreter running `<prefix>/bin/hermes`), or a source checkout run as
`python -m hermes_cli`. A renamed or look-alike wrapper (`hermes-notes`,
`hermes.py`, the `hermes-agent` runner) is refused; every tool call then fails
closed with `preparation-refused` and `isonapse hook doctor` reports the
refusal as unauthenticated Hook ingress.
