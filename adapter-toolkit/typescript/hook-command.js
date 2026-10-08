// Hook-command hosts (OpenAI Codex CLI hooks, Claude-shaped `hooks.json` hosts)
// start ONE fresh adapter process per native hook event, hand it one JSON event
// on stdin and read a host-shaped answer from its stdout/exit status. Nothing
// survives between events except what the Hook and daemon persist themselves,
// so the in-process `Runtime` (pre -> effect -> post inside one call) does not
// fit. This helper is its process-per-event counterpart: decode one canonical
// event, consult the shipped `Client` at the right boundary, apply the decision
// with `execute`/`deliver`, and report a typed outcome. It never renders a host
// wire format: the host adapter turns the outcome into its own response and
// remains responsible for answering EVERY path explicitly when the host fails
// open on a silent or crashed hook.
import {MAX_BYTES, Refused, Unavailable, decodeHostEvent, deliver, execute, snapshot} from "./index.js";

/** Canonical hook-command events and the Protocol v1 boundary each one uses. */
export const HOOK_COMMAND_EVENTS = Object.freeze({
  SessionStart: Object.freeze({event:"session-start", boundary:"lifecycle"}),
  SessionEnd: Object.freeze({event:"session-end", boundary:"lifecycle"}),
  PreToolUse: Object.freeze({event:"pre-tool-use", boundary:"pre"}),
  PostToolUse: Object.freeze({event:"post-tool-use", boundary:"post"}),
});

// Only these host fields reach the Hook. A host payload cannot smuggle prompt,
// expansion or transcript fields into a tool-call request.
const FORWARDED = Object.freeze(["session_id","cwd","hook_event_name","tool_use_id","tool_name","tool_input","tool_response","agent_id","agent_type"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (_key, item) =>
  object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** Read one bounded host event from a byte stream (stdin by default). */
export async function readHostEvent(stream = process.stdin, {maxBytes = MAX_BYTES} = {}) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw Error();
      chunks.push(buffer);
    }
  } catch {
    throw new Unavailable("Host event is not bounded plain JSON");
  }
  return decodeHostEvent(Buffer.concat(chunks));
}

function outcome(event, boundary, kind, {error, decision, input, output} = {}) {
  const result = {event, boundary, kind};
  if (error) result.reason = decision?.reason ? `${error.message}: ${decision.reason}` : error.message;
  // The Hook was never consulted (identity, transport or protocol): name why.
  if (error instanceof Unavailable && typeof error.code === "string") result.cause = error.code;
  if (decision?.operatorMessage) result.operatorMessage = decision.operatorMessage;
  if (decision) result.decision = decision;
  if (input !== undefined) result.input = input;
  if (output !== undefined) result.output = output;
  return Object.freeze(result);
}

/**
 * Decide one canonical host event through the shipped Client.
 *
 * Returns a frozen outcome whose `kind` is the only field to branch on:
 * lifecycle `acknowledged`/`refuse`; pre-action `proceed` (run the exact
 * original input), `rewrite` (run exactly `input`) or `refuse` (do not run);
 * post-action `deliver` (show the original result), `replace` (show exactly
 * `output`) or `withhold` (show nothing of the result). `reason` and
 * `operatorMessage` are display text. `cause` is present only when the Hook
 * gave no decision: the `Unavailable.code` (`hook-identity:<cause>`,
 * `hook-transport` or `hook-protocol`). Transport failure and every refusal
 * are outcomes, never allows; a malformed event throws before the Hook runs.
 */
export async function hookCommand(client, payload, {approve, checkVersion = false, signal} = {}) {
  const event = snapshot(payload);
  if (!object(event)) throw new Unavailable("Host event is not bounded plain JSON");
  const name = event.hook_event_name;
  const mapping = typeof name === "string" && Object.hasOwn(HOOK_COMMAND_EVENTS, name) ? HOOK_COMMAND_EVENTS[name] : undefined;
  if (!mapping) throw new Refused("Unsupported hook-command event");
  const {boundary} = mapping;
  const request = {};
  for (const field of FORWARDED) if (field in event) request[field] = event[field];
  // Identity is checked here as well as in the Client so a malformed event is
  // refused before any Hook process starts.
  if (typeof request.session_id !== "string" || !request.session_id) throw new TypeError("Stable native session identity required");
  if (boundary !== "lifecycle" && (typeof request.tool_use_id !== "string" || !request.tool_use_id)) throw new TypeError("Stable native tool-call identity required");
  if (boundary === "pre" && !object(request.tool_input)) throw new TypeError("A pre-action event requires a tool_input object");
  if (boundary === "post" && !("tool_response" in request)) throw new TypeError("A post-action event requires tool_response");
  const refusal = {lifecycle:"refuse", pre:"refuse", post:"withhold"}[boundary];
  let decision;
  try {
    if (checkVersion) await client.checkVersion();
    decision = await client.decide(mapping.event, request, {boundary, signal});
  } catch (error) {
    if (error instanceof Unavailable || error instanceof Refused) return outcome(mapping.event, boundary, refusal, {error});
    throw error;
  }
  if (boundary === "lifecycle") {
    return decision.decision === "allow"
      ? outcome(mapping.event, boundary, "acknowledged", {decision})
      : outcome(mapping.event, boundary, refusal, {error:new Refused("Isonapse did not acknowledge this lifecycle event"), decision});
  }
  if (boundary === "pre") {
    try {
      const input = await execute(decision, request.tool_input, selected => selected, {approve});
      const kind = canonical(input) === canonical(request.tool_input) ? "proceed" : "rewrite";
      return outcome(mapping.event, boundary, kind, {decision, input});
    } catch (error) {
      if (error instanceof Refused || error instanceof Unavailable) return outcome(mapping.event, boundary, refusal, {error, decision});
      throw error;
    }
  }
  try {
    const output = deliver(decision, request.tool_response);
    const kind = canonical(output) === canonical(request.tool_response) ? "deliver" : "replace";
    return outcome(mapping.event, boundary, kind, {decision, output});
  } catch (error) {
    if (error instanceof Refused || error instanceof Unavailable) return outcome(mapping.event, boundary, refusal, {error, decision});
    throw error;
  }
}
