import test from "node:test";
import assert from "node:assert/strict";
const entry = process.env.ISONAPSE_ADK_TEST_PACKAGE || new URL("../index.js", import.meta.url).href;
const {decode,Refused,execute,Unavailable} = await import(entry);
const {Runtime} = await import(new URL("runtime.js", entry).href);
const {replaceExecutableInput} = await import(new URL("input.js", entry).href);

test("shared Pi seam installs exact keys without prototype pollution or partial permission", () => {
  const target={old:"must disappear"};
  const replacement=JSON.parse('{"__proto__":{"polluted":true},"path":"approved"}');
  assert.equal(replaceExecutableInput(target,replacement),undefined);
  assert.deepEqual(Object.keys(target).sort(),["__proto__","path"]);
  assert.equal(Object.getPrototypeOf(target),Object.prototype);
  assert.equal(target.polluted,undefined);
  assert.deepEqual(target.__proto__,{polluted:true});
  const locked={};Object.defineProperty(locked,"old",{value:true,configurable:false});
  assert.match(replaceExecutableInput(locked,{path:"approved"}),/cannot be removed exactly/);
  assert.equal(locked.path,undefined);
});

test("invalid native results explicitly leave completion unknown without retry", async () => {
  let calls=0,effects=0;
  const client={async decide(){calls++;return decode('{"protocolVersion":1,"decision":"allow"}',"pre");}};
  const runtime=new Runtime(client,"session","/repo",{notify(){}});
  for (const output of [new Set(), "x".repeat(1024*1024+1)]) {
    await assert.rejects(runtime.tool("call","Read",{},()=>{effects++;return output;}), /completion unknown.*do not retry/);
  }
  assert.equal(calls,2);assert.equal(effects,2);
});

test("non-JSON inputs cannot authorize different serialized bytes", async () => {
  let calls=0,effects=0;
  const client={async decide(){calls++;return decode('{"protocolVersion":1,"decision":"allow"}',"pre");}};
  const runtime=new Runtime(client,"session","/repo",{notify(){}});
  const getter={};Object.defineProperty(getter,"x",{enumerable:true,get(){throw Error("must not invoke getter");}});
  for (const value of [new Map([["hidden","value"]]),new Set([1]),new Date(),undefined,Infinity,()=>{},getter]) {
    await assert.rejects(runtime.tool("call","Read",{x:value},()=>{effects++;return "output";}),Unavailable);
  }
  assert.equal(calls,0);assert.equal(effects,0);
});

test("one decision cannot execute twice or race approval and mutation", async () => {
  const original={path:"safe"}, effects=[];
  const decision=decode(JSON.stringify({protocolVersion:1,decision:"ask",reason:"review"}),"pre");
  const first=execute(decision,original, value=>effects.push(value),{approve:async()=>{original.path="changed"; await Promise.resolve(); return true;}});
  await assert.rejects(execute(decision,original,value=>effects.push(value),{approve:()=>true}),Refused);
  await first;
  assert.deepEqual(effects,[{path:"safe"}]);
  const rewrite=decode(JSON.stringify({protocolVersion:1,decision:"allow",effectiveInput:{nested:{path:"safe"}}}),"pre");
  assert.throws(()=>{rewrite.effectiveInput.nested.path="changed";},TypeError);
});

test("caller mutation cannot change authorized input or scanned output", async () => {
  const args={path:"safe"}, output={text:"scanned"}, effects=[];
  const client={async decide(_event,_request,{boundary}) {
    await Promise.resolve();
    if (boundary === "pre") args.path="changed"; else output.text="unscanned";
    return decode('{"protocolVersion":1,"decision":"allow"}',boundary);
  }};
  const runtime=new Runtime(client,"session","/repo",{notify() {}});
  const visible=await runtime.tool("one","Read",args,value=>{effects.push(value); return output;});
  assert.deepEqual(effects,[{path:"safe"}]);
  assert.deepEqual(visible,{text:"scanned"});
});

test("native callbacks execute exact rewrite and correlate completion before delivery", async () => {
  const calls = [], effects = [];
  const client = {
    async checkVersion() {},
    async decide(event, request, {boundary}) {
      calls.push([event,structuredClone(request)]);
      return decode(JSON.stringify({protocolVersion:1,decision:"allow", ...(boundary === "pre" ? {effectiveInput:{path:"safe"}} : boundary === "post" ? {updatedOutput:"redacted"} : {})}),boundary);
    }
  };
  const runtime = new Runtime(client,"native-session","/repo",{notify() {}});
  await runtime.start();
  assert.equal(await runtime.tool("one","Read",{path:"unsafe",extra:true}, async args => {effects.push(structuredClone(args)); args.path="mutated"; return "private";}),"redacted");
  await runtime.end();
  assert.deepEqual(effects,[{path:"safe"}]);
  assert.deepEqual(calls.map(([event])=>event),["session-start","pre-tool-use","post-tool-use","session-end"]);
  assert.deepEqual(calls[2][1].tool_input,{path:"safe"});
  assert.equal(calls[2][1].tool_use_id,"one");
  assert.equal(calls[2][1].tool_response,"private");
});

test("refusal blocks effects and completion failure never repeats them", async () => {
  let count=0, kind="deny";
  const client={async decide(_event,_request,{boundary}) {
    const decision=boundary === "pre" ? kind : "unavailable";
    return decode(JSON.stringify({protocolVersion:1,decision,...(decision === "allow" ? {} : {reason:"fixture refusal"}),...(decision === "unavailable" ? {retryable:false} : {})}),boundary);
  }};
  const runtime=new Runtime(client,"session","/repo",{notify() {}});
  await assert.rejects(runtime.tool("one","Read",{},()=>{count++;return "output";}),Refused);
  assert.equal(count,0);
  kind="allow";
  await assert.rejects(runtime.tool("two","Read",{},()=>{count++;return "output";}),Refused);
  assert.equal(count,1);
});
