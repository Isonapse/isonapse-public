-- 02-loop-allowlist.lua — table-build loop generates per-subcommand rules.
--
-- This example PERMITs git ONLY when the subcommand is one of
-- {status, log, diff, show, branch, stash}. Everything else falls through
-- to the gate's default layers (the destructive veto knocks
-- `git reset --hard` down to "ask the human"; the learned gate may permit
-- benign subcommands it has seen before).
--
-- This is an ALLOWLIST: the unlisted case defers to a human. Expressing it
-- as `tool:Bash:git = PERMIT` plus a check_action that denies the bad
-- subcommands would be a BLOCKLIST, where a git subcommand nobody thought
-- of is permitted by default. That is the whole lesson.
--
-- `git status` mints the capability `tool:Bash:git:status`, so each
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
  "branch",
  "stash",  -- stash list / pop are reversible; not strictly read-only but operator-trusted
}

local actions = {}
for _, sub in ipairs(READ_ONLY_GIT) do
  actions["tool:Bash:git:" .. sub] = {
    decision = "PERMIT",
    reason = "read-only or reversible git subcommand",
    trust = "local",  -- git runs on this host
  }
end

return {
  policy_version = "git-readonly-allowlist-v1",
  actions = actions,
}
