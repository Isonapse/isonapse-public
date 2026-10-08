# Adapter scaffold

> **Status — Public beta:** Protocol v1 starter and synthetic conformance target.

`adapter.py` is an executable, standard-library Protocol v1 reference used by
the conformance suite's synthetic host. Run it green before replacing
`apply_decision` with your host's native execution/result APIs and changing
`HOST_ID` to an accepted profile id.

The default 55-second wrapper deadline leaves teardown margin around the
installed hook's 50-second deadline. The suite supplies a complete test-only
sentinel set that shortens it to 500 ms for the hung-hook fixture; do not turn
that seam into a production timeout or fail-open setting.

Do not ship the synthetic shell executor in a real agent integration. It exists
only so the suite can observe the fixture's actual authorized effect.
