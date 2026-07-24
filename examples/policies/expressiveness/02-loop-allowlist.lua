-- 02-loop-allowlist.lua — table-build loop generates per-subcommand rules.
--
-- This example PERMITs `tool:Bash:git` ONLY
-- when the subcommand is one of {status, log, diff, show, branch, stash}.
-- Everything else falls through to the gate's default layers (the
-- destructive veto knocks `git reset --hard` down to "ask the human";
-- the learned gate may permit benign subcommands it has seen before).
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
