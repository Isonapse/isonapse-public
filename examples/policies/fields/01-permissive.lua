-- 01-permissive.lua — the minimum loadable policy.
--
-- This file is the smallest possible policy: an empty table that the engine
-- treats as "no rules" — every capability falls through to the gate's other
-- layers (destructive veto, learned gate, DEFER) without being denied or
-- permitted explicitly.
--
-- POLICY_VERSION exists on every policy as an operator-supplied free-form
-- label (SemVer, a git rev, a YYYY-MM-DD.N stamp — whatever you find
-- operationally meaningful). It's stamped on every gate-decision witness
-- receipt's `policy_version` field so an auditor replaying the chain can
-- answer "which policy version was in force at time T". The Blake3
-- `policy_hash` (commits to the literal bytes of THIS file) is the
-- machine-verifiable companion — use both.
--
-- Try it:
--   1. Save this file as ~/.isonapse/policy/policy.lua
--   2. Restart the controlplane: `isonapse hook stop && isonapse hook start`
--   3. `isonapse hook policy show --summary` — every count should be 0
--   4. Any agent action falls through to the gate's default layers.

return {
  policy_version = "permissive-baseline-v1",
}
