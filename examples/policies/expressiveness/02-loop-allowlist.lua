-- 02-loop-allowlist.lua — table-build loop generates per-subcommand rules.
--
-- This example PERMITs git ONLY when the subcommand is one of
-- {status, log, diff, show}. Everything else keeps Isonapse's own checks:
-- in Enforce, `git reset --hard` asks you first, and work like what you
-- approved before may pass.
--
-- This is an ALLOWLIST: unlisted commands keep Isonapse's other checks. Expressing it
-- as `tool:Bash:git = PERMIT` plus a check_action that denies the bad
-- subcommands would be a BLOCKLIST, where a git subcommand nobody thought
-- of is permitted by default. That is the whole lesson.
--
-- `git status` produces the capability `tool:Bash:git:status`, so each
-- generated key names a capability the hook really produces. Commands whose
-- first operand is NOT a subcommand — `cat`, `rm` — never gain that segment,
-- because there the second word is your filename, not a verb.
--
-- In JSON you'd write each subcommand as a separate object. In Lua you
-- write the LIST and let the loop generate the rules — adding a new
-- read-only subcommand is a one-line change instead of a copy-paste.

local READ_ONLY_GIT = {
  "status",
  "log",
  "diff",
  "show",
}

-- Do not add branch or stash here: their capabilities also cover
-- `git branch -D`, `git stash clear` and `git stash drop`.

local actions = {}
for _, sub in ipairs(READ_ONLY_GIT) do
  actions["tool:Bash:git:" .. sub] = {
    decision = "PERMIT",
    reason = "read-only git subcommand",
    trust = "local",  -- git runs on this host
  }
end

return {
  policy_version = "git-readonly-allowlist-v1",
  actions = actions,
}
