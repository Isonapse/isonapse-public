# Example policies

Isonapse policies are plain Lua files. Each file returns a table of policy
fields; optionally it defines a `check_action(ctx)` function that is
consulted per action at evaluation time. Policies run in a sandbox with no
I/O — they can only decide, never act.

| File | Shows |
|---|---|
| [`01-protect-secrets.lua`](01-protect-secrets.lua) | Blocking writes to secret files with one shared pattern list |
| [`02-domain-allowlist.lua`](02-domain-allowlist.lua) | Allowlisting network egress, and why blocked beats allowed |
| [`03-runtime-rules.lua`](03-runtime-rules.lua) | Per-action runtime decisions with `check_action(ctx)` |

`isonapse hook init` sets up a starter policy for you and prints where it
lives; start from these examples when you want to go further. Decisions are
deterministic: the same policy and the same action always produce the same
answer, and every decision is recorded.
