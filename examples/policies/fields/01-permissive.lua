-- 01-permissive.lua — the minimum loadable policy.
--
-- This file is the smallest possible policy: an empty table that the engine
-- treats as "no rules": no action is refused or allowed by a rule of yours,
-- and Isonapse's own checks still apply.
--
-- POLICY_VERSION exists on every policy as an operator-supplied free-form
-- label (SemVer, a git rev, a YYYY-MM-DD.N stamp — whatever you find
-- operationally meaningful). Every decision record carries it, so an
-- auditor can tell which policy version was in force at the time. The
-- Blake3 `policy_hash` (commits to the literal bytes of THIS file) is the
-- machine-verifiable companion — use both.
--
-- Try it: `isonapse hook policy check 01-permissive.lua` loads it without
-- changing anything.

return {
  policy_version = "permissive-baseline-v1",
}
