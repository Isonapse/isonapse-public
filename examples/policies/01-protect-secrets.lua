-- 01-protect-secrets.lua — keep an agent away from secret material on disk.
--
-- One shared list of secret-file patterns, applied to file writes. Because
-- the policy is Lua, the list is written once and every rule that needs it
-- derives from it — edit the list, and every site updates together.

local SECRET_PATTERNS = {
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/.aws/credentials",
}

return {
  policy_version = "protect-secrets-v1",

  -- No agent may write to files matching these patterns.
  blocked_file_patterns = {
    ["cap:file-write"] = SECRET_PATTERNS,
  },
}
