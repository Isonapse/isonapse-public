-- 06-file-patterns.lua — file-path matching, OverlayFS hides, payload caps.
--
-- Three filesystem-shaped fields:
--
-- 1) `blocked_file_patterns[<cap>]` — DENY if the path the capability
--    targets matches any pattern. Fires for capabilities that carry a
--    `path` in their context (typically `cap:file-read`, `cap:file-write`,
--    and the underlying tool:Read / tool:Write / tool:Edit hooks).
--
-- 2) `hidden_file_patterns` — FLAT list (not capability-keyed). At
--    container deploy time, the platform populates OverlayFS whiteouts
--    so matched paths return ENOENT (not EACCES) to the agent. The
--    agent literally cannot see they exist. Enforcement is
--    `[proxy] fs_overlay_enabled = true` in the SAC manifest. A policy
--    that declares hidden_file_patterns without the manifest switch
--    parses without error but the deploy logs a WARN.
--
-- 3) `max_payload_size[<cap>]` — DENY if the capability's payload (the
--    body bytes about to be written, posted, etc.) exceeds the cap.
--    Useful for blocking accidental megabyte-scale writes from agents
--    that thought they were appending a line.
--
-- The matcher is intentionally NARROW (no full regex). Five shapes:
--
--   name             — bare basename match (no slashes).
--   **/name          — any path whose final component equals `name`.
--   **/prefix*       — basename starts with `prefix`.
--   **/*suffix       — basename ends with `suffix`.
--   **/*infix*       — basename contains `infix`.
--   /absolute/path   — literal full-path equality.
--
-- Patterns NOT of these shapes are treated as literal-basename matches.
-- `**/*` alone (empty infix) is treated as "no match" — defensive
-- against typos that would otherwise match everything.

return {
  policy_version = "file-patterns-v1",

  blocked_file_patterns = {
    -- Reads: block secrets-ish files anywhere in the tree.
    ["cap:file-read"] = {
      "**/.env",
      "**/.env.local",
      "**/.env.*",
      "**/.aws/credentials",
      "**/*.pem",
      "**/credentials*",
    },
    -- Writes: block writes to policy / managed-settings files so an
    -- agent can't self-protection-bypass.
    ["cap:file-write"] = {
      "**/isonapse*",          -- isonapse-* binaries and configs
      "**/managed-settings*",  -- Claude Code managed settings
      "/etc/sudoers",
    },
    -- Same patterns applied at the Claude Code tool layer (Write/Edit
    -- often skip the deeper cap:file-write capability check because
    -- the hook intercepts earlier).
    ["tool:Write"] = {
      "**/.env",
      "**/.env.*",
      "**/*.pem",
    },
    ["tool:Edit"] = {
      "**/.env",
      "**/.env.*",
      "**/*.pem",
    },
  },

  -- Hidden via OverlayFS whiteout. Same matcher; flat list, not keyed.
  -- Effective at container deploy time. The agent's `ls -la` does not
  -- show these paths at all.
  hidden_file_patterns = {
    "**/.ssh",
    "**/.gnupg",
    "**/.aws",
    "/etc/shadow",
  },

  -- Payload size limits. A tool:Write of 5 MiB into the workspace is
  -- almost certainly an accident.
  max_payload_size = {
    ["tool:Write"] = 1048576,        -- 1 MiB
    ["cap:file-write"] = 1048576,    -- match the Write cap above
    ["cap:http-request"] = 524288,   -- 512 KiB — HTTP request bodies
  },
}
