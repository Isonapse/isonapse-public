-- 05-base-plus-overrides.lua — layered authoring via deep table-merge.
--
-- Organisations converge on a two-layer policy structure:
--
--   BASE      — what's true for every team / project (org-wide baseline).
--   OVERRIDES — what's specific to THIS team / project.
--
-- JSON can't compose. You'd either fork the BASE for every team (drift
-- inevitable) or write a custom merge tool. Lua composes naturally:
-- author both layers as Lua tables, deep-merge at the bottom of the
-- file, return the result. The engine sees ONE policy; the author sees
-- the two-layer structure.
--
-- Production fleets usually pull the BASE from a shared repo and only
-- vary the OVERRIDES per team. This file shows both layers in one
-- place for illustration.

-- Org baseline — every team gets these.
local BASE = {
  rate_limits = {
    ["tool:Bash"] = { per_minute = 30, per_hour = 200 },
    ["cap:llm-invoke"] = { per_minute = 20 },
  },
  blocked_capabilities = {
    ["agent:*"] = { "tool:Bash:sudo", "tool:Bash:dd" },
  },
  llm = {
    allowed_models = {
      "claude-sonnet-4-6",
    },
    max_input_tokens = 16384,
    budget_per_task_usd = 2.00,
  },
}

-- Team-specific overrides — billing has stricter LLM models, tighter
-- budget, and adds a few sensitive paths to the blocked-write list.
local OVERRIDES = {
  llm = {
    allowed_models = {
      "claude-sonnet-4-6",
      -- billing-only model addition for invoice reconciliation
      "gpt-4o-mini",
    },
    budget_per_task_usd = 1.00,  -- tighter than the base $2.00
  },
  blocked_file_patterns = {
    ["cap:file-write"] = {
      "**/invoices/*.lock",
      "**/billing/*.snapshot",
    },
  },
}

-- Deep merge — for each top-level field:
--   * if BOTH sides have a map, merge keys (override wins on collision)
--   * if EITHER side has a value, use the non-nil one (override wins)
--   * arrays are REPLACED, not appended, because policy lists are
--     semantically "this is the whole set" — appending creates surprise
--     when overrides shrink the set.
local function deep_merge(base, override)
  if type(base) ~= "table" or type(override) ~= "table" then
    return override == nil and base or override
  end
  -- Detect array-shaped tables (1..N integer keys) → replace, don't merge.
  if #override > 0 and override[1] ~= nil then
    return override
  end
  local out = {}
  for k, v in pairs(base) do out[k] = v end
  for k, v in pairs(override) do
    out[k] = deep_merge(base[k], v)
  end
  return out
end

local policy = deep_merge(BASE, OVERRIDES)
policy.policy_version = "billing-team-override-v1"
return policy
