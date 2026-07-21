-- 03-helper-functions.lua — declarative DSL built from a handful of
-- locals.
--
-- Once a policy grows past 30 lines, the field-name boilerplate
-- (`decision = "PERMIT", reason = "..."`) drowns out intent. Wrap
-- common shapes in helper functions and the rest of the policy reads
-- like a spec.

local function permit(reason)
  return { decision = "PERMIT", reason = reason }
end

local function deny(reason)
  return { decision = "DENY", reason = reason }
end

local function local_permit(reason, allowed_secrets)
  return {
    decision = "PERMIT",
    reason = reason,
    trust = "local",
    allowed_secrets = allowed_secrets or {},
  }
end

local function rate(per_min, per_hour)
  local rl = { per_minute = per_min }
  if per_hour then rl.per_hour = per_hour end
  return rl
end

return {
  policy_version = "helper-functions-v1",

  actions = {
    ["tool:Bash:git"]   = permit("operator-trusted git workflows"),
    ["tool:Bash:rm"]    = deny("destructive — use trash-cli or a scoped script"),
    ["tool:Bash:sudo"]  = deny("no privilege escalation"),
    ["tool:Bash:psql"]  = local_permit(
      "trusted dev DB client",
      { "DEV_DB_URL" }
    ),
  },

  rate_limits = {
    ["tool:Bash"]     = rate(30, 200),
    ["tool:WebFetch"] = rate(10, 60),
    ["cap:llm-invoke"] = rate(20),
  },
}
