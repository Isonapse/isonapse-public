-- 01-shared-list.lua — one Lua local, three policy sites.
--
-- The cheapest win Lua-over-JSON gives you: a SINGLE SOURCE OF TRUTH
-- shared between multiple policy fields. JSON would force you to repeat
-- the list at every site and stay perfectly in sync forever; Lua lets
-- you write it once.
--
-- Here we have a list of production database identifiers that should be
-- denied as a CAPABILITY (so nobody invokes them), excluded from the
-- DOMAIN allowlist (so nothing reaches them by hostname), and blocked
-- from FILE-WRITE paths (so config files referencing them stay
-- read-only). Editing the list updates all three sites at once.

local PROD_DBS = {
  "prod-db-1",
  "prod-db-2",
  "billing-replica",
}

-- Derive the capability list to deny: tool:Bash:psql:<host>.
local function blocked_capability_list()
  local caps = {}
  for _, host in ipairs(PROD_DBS) do
    caps[#caps + 1] = "tool:Bash:psql:" .. host
  end
  return caps
end

-- Derive the domain list (same hosts, .internal suffix).
local function blocked_domain_list()
  local domains = {}
  for _, host in ipairs(PROD_DBS) do
    domains[#domains + 1] = host .. ".internal"
  end
  return domains
end

-- Derive the file-write pattern list — config files in /etc that
-- reference any of these hosts.
local function blocked_file_pattern_list()
  local patterns = {}
  for _, host in ipairs(PROD_DBS) do
    patterns[#patterns + 1] = "**/" .. host .. ".conf"
    patterns[#patterns + 1] = "**/" .. host .. ".cfg"
  end
  return patterns
end

return {
  policy_version = "shared-list-v1",

  blocked_capabilities = {
    ["agent:*"] = blocked_capability_list(),
  },

  blocked_domains = {
    ["tool:WebFetch"] = blocked_domain_list(),
  },

  blocked_file_patterns = {
    ["cap:file-write"] = blocked_file_pattern_list(),
  },
}
