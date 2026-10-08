import {Refused, Unavailable, execute, deliver, snapshot} from "./index.js";

/** Native callbacks only: no shell executor or model-selected identity. */
export class Runtime {
  constructor(client, sessionId, cwd, {notify, approve} = {}) {
    if (typeof sessionId !== "string" || !sessionId || typeof cwd !== "string" || !cwd || typeof notify !== "function") throw new TypeError("Trusted native identity and operator notification required");
    this.client = client; this.sessionId = sessionId; this.cwd = cwd;
    this.notify = notify; this.approve = approve;
    Object.freeze(this);
  }
  async _decide(event, request, boundary) {
    const names={"session-start":"SessionStart","session-end":"SessionEnd","pre-tool-use":"PreToolUse","post-tool-use":"PostToolUse"};
    const decision = await this.client.decide(event, {...request, hook_event_name:names[event], session_id:this.sessionId, cwd:this.cwd}, {boundary});
    if (decision.operatorMessage) await this.notify(decision.operatorMessage);
    return decision;
  }
  async start() {
    await this.client.checkVersion();
    if ((await this._decide("session-start", {}, "lifecycle")).decision !== "allow") throw new Refused("Session startup was not allowed");
  }
  async end() {
    if ((await this._decide("session-end", {}, "lifecycle")).decision !== "allow") throw new Refused("Session shutdown was not acknowledged");
  }
  async tool(callId, name, args, effect) {
    args = snapshot(args);
    const request = {tool_use_id:callId, tool_name:name, tool_input:args};
    const decision = await this._decide("pre-tool-use", request, "pre");
    return execute(decision, args, async selected => {
      const applied = snapshot(selected);
      let output, failed = false;
      try { output = await effect(selected); }
      catch { failed = true; output = {is_error:true, error:"Native tool callback failed"}; }
      let completion;
      try {
        output = snapshot(output);
        completion = await this._decide("post-tool-use", {...request, tool_input:applied, tool_response:output}, "post");
      } catch {
        throw new Unavailable("Native effect already ran; completion unknown. Output withheld; do not retry the effect.");
      }
      const visible = deliver(completion, output);
      if (failed) throw new Refused("Native tool failed; completion reported");
      return visible;
    }, {approve:this.approve});
  }
}
