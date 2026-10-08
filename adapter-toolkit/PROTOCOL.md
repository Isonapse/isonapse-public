# Host Adapter Protocol v1

An adapter receives one native host event as UTF-8 JSON on stdin. It invokes:

```text
isonapse-hook <native-event> --host <registered-host-id> --adapter-protocol 1
```

It forwards the event bytes on the hook's stdin. A successful hook prints one
JSON object on stdout:

```json
{"protocolVersion":1,"decision":"allow","effectiveInput":{"command":"…"}}
```

## Response fields

| Field | Contract |
| --- | --- |
| `protocolVersion` | Always `1`; abort on every other value. |
| `decision` | `allow`, `deny`, `ask`, or `unavailable`; abort on unknown values. |
| `reason` | Human diagnostic only. Never parse it to choose behavior. |
| `effectiveInput` | Exact replacement input authorized for a pre-action. |
| `updatedOutput` | Exact replacement result allowed at a post-action. |
| `retryable` | Diagnostic retry hint on `unavailable`; never permission to fail open. |

Additional fields may appear in a v1 response and must not alone make a valid
response fail. Optional fields are omitted rather than encoded as null.

## Mandatory behavior

1. Pass the native event, explicit registered host id, and
   `--adapter-protocol 1`; never fall back to another profile.
2. Cap a hook response at 1 MiB and impose a deadline. Kill and reap a hook
   that exceeds either bound.
3. Treat a non-zero hook exit, malformed JSON, wrong protocol version, or
   unknown decision as no authorization and refuse the action.
4. Branch only on `decision`, never words in `reason`.
5. On `allow`, replace executable input with `effectiveInput` when present.
   It is a replacement, not a merge: removed keys must stay removed. If the
   host cannot apply it exactly, abort.
6. On a post-action, replace the model-visible result with `updatedOutput`
   when present. If exact replacement is impossible, withhold the result.
7. `deny` and `unavailable` refuse. `ask` may proceed only after the host's
   declared native approval surface returns affirmative approval.
8. Never let a warning/notification failure reverse a typed refusal.

The canonical hook's adapter deadline is 50 seconds; a host wrapper should
leave teardown margin around it (the scaffold uses 55 seconds). The conformance
runner sets `ISONAPSE_CONFORMANCE_TIMEOUT_MS=500` together with four private
stub paths so the hung-hook proof finishes quickly. A candidate may recognize
that complete test-only sentinel set to shorten its deadline, but must ignore
it in ordinary operation and must never use it to widen or bypass a refusal.

The host profile, not the adapter request, declares `can_rewrite_input`,
`can_rewrite_output`, and `can_ask`. The daemon converts two decisions a
registered host cannot carry into a witnessed deny before returning them: a
permit whose bound effect rewrote the input on a host without input
replacement, and a defer on a host that cannot ask. It does **not** convert a
post-action replacement: a host without output replacement still receives
`allow` with `updatedOutput`, and rule 6 applies, so the adapter itself must
withhold the result (that is what the `deny-with-output-replacement` and
`output-rewrite` fixtures demand of an incapable host). An `ask` can also reach
an adapter without any daemon conversion when the Hook decides locally: an
unknown or already-ended session, or a process that is not the registered
issuer. Those asks carry no receipt; rule 7 means an adapter without a native
approval surface refuses them.

## Exit convention for conformance candidates

The standalone suite drives an executable as `<adapter> <event>`. Exit `0`
means the authorized effect was applied. Any non-zero status means refusal.
For synthetic post-action fixtures, write only the model-visible result to
stdout. For pre-actions, execute the authorized fixture command. Production
host integrations normally install those effects through host APIs instead.
