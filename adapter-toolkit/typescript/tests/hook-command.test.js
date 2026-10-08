import test from "node:test";
import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {mkdtemp,mkdir,writeFile,chmod,rm,realpath,rename} from "node:fs/promises";
import {createRequire,syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
const entry = process.env.ISONAPSE_ADK_TEST_PACKAGE || new URL("../index.js", import.meta.url).href;
const {Client,InstalledHook,Refused,Unavailable,decode,decodeHostEvent} = await import(entry);
const {HOOK_COMMAND_EVENTS,hookCommand,readHostEvent} = await import(new URL("hook-command.js", entry).href);

const wire=(decision="allow",fields={})=>JSON.stringify({protocolVersion:1,decision,...fields});
// Codex CLI 0.155.1 payload shapes: canonical fields plus host-native extras.
const codex=(name,extra={})=>({session_id:"thread-1",cwd:"/work",hook_event_name:name,model:"scripted",permission_mode:"bypassPermissions",transcript_path:null,...extra});
const pre=(extra={})=>codex("PreToolUse",{tool_use_id:"call-1",tool_name:"Bash",tool_input:{command:"printf ok"},turn_id:"turn-1",...extra});
const post=(extra={})=>codex("PostToolUse",{tool_use_id:"call-1",tool_name:"Bash",tool_input:{command:"printf ok"},tool_response:"ok",turn_id:"turn-1",...extra});

function fake(respond) {
  const calls=[];
  let versions=0;
  return {
    calls,
    get versions() {return versions;},
    async checkVersion() {versions++;},
    async decide(event,request,{boundary}) {
      calls.push({event,request:structuredClone(request),boundary});
      return decode(await respond(event,request,boundary),boundary);
    },
  };
}

test("host events are bounded, strictly decoded objects",async()=>{
  const read=(...chunks)=>readHostEvent(Readable.from(chunks.map(chunk=>Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk))));
  assert.deepEqual(await read('{"a":1}'),{a:1});
  assert.deepEqual(await read('{"a":',"1}"),{a:1});
  for (const bad of ['{"a":1,"a":2}','[]','"x"','{"a":1','{"a":{"b":1,"b":2}}',Buffer.from([0x7b,0xff,0x7d]),'{"a":'+'x'.repeat(1024*1024)+'}']) {
    await assert.rejects(read(bad),Unavailable);
  }
  await assert.rejects(readHostEvent(Readable.from([Buffer.from('{"a":"0123456789"}')]),{maxBytes:8}),Unavailable);
  const polluted=decodeHostEvent('{"__proto__":{"polluted":true},"a":1}');
  assert.equal(({}).polluted,undefined);
  assert.equal(Object.getPrototypeOf(polluted),Object.prototype);
  assert.deepEqual(Object.keys(polluted).sort(),["__proto__","a"]);
  assert.deepEqual(HOOK_COMMAND_EVENTS.PreToolUse,{event:"pre-tool-use",boundary:"pre"});
  assert.ok(Object.isFrozen(HOOK_COMMAND_EVENTS));
});

test("pre-action outcomes: proceed on an exact allow, rewrite on effectiveInput, refuse on everything else",async()=>{
  let response=wire();
  const client=fake(()=>response);
  let out=await hookCommand(client,pre());
  assert.equal(out.kind,"proceed");
  assert.deepEqual(out.input,{command:"printf ok"});
  assert.equal(out.reason,undefined);
  assert.ok(Object.isFrozen(out));
  assert.deepEqual(client.calls.at(-1).event,"pre-tool-use");
  assert.equal(client.calls.at(-1).boundary,"pre");
  response=wire("allow",{effectiveInput:{command:"printf [REDACTED]"}});
  out=await hookCommand(client,pre());
  assert.equal(out.kind,"rewrite");
  assert.deepEqual(out.input,{command:"printf [REDACTED]"});
  // Key order is not a rewrite; a removed key is.
  response=wire("allow",{effectiveInput:{b:2,a:1}});
  assert.equal((await hookCommand(client,pre({tool_input:{a:1,b:2}}))).kind,"proceed");
  response=wire("allow",{effectiveInput:{a:1}});
  out=await hookCommand(client,pre({tool_input:{a:1,b:2}}));
  assert.equal(out.kind,"rewrite");
  assert.deepEqual(out.input,{a:1});
  response=wire("deny",{reason:"policy says no",operatorMessage:"operator note"});
  out=await hookCommand(client,pre());
  assert.equal(out.kind,"refuse");
  assert.match(out.reason,/did not permit/);
  assert.match(out.reason,/policy says no/);
  assert.equal(out.operatorMessage,"operator note");
  assert.equal(out.input,undefined);
  assert.equal(out.decision.decision,"deny");
  response=wire("unavailable",{reason:"daemon down",retryable:true});
  out=await hookCommand(client,pre());
  assert.equal(out.kind,"refuse");
  assert.equal(out.decision.retryable,true);
  // `ask` is a refusal unless the host supplies a real approval surface.
  response=wire("ask",{reason:"review"});
  out=await hookCommand(client,pre());
  assert.equal(out.kind,"refuse");
  assert.match(out.reason,/approval was not granted/);
  let approvals=0;
  out=await hookCommand(client,pre(),{approve:()=>{approvals++;return false;}});
  assert.equal(out.kind,"refuse");
  assert.equal(approvals,1);
  assert.equal((await hookCommand(client,pre(),{approve:()=>true})).kind,"proceed");
  response=wire("ask",{reason:"review",effectiveInput:{command:"approved"}});
  out=await hookCommand(client,pre(),{approve:()=>true});
  assert.equal(out.kind,"rewrite");
  assert.deepEqual(out.input,{command:"approved"});
});

test("post-action outcomes: deliver, replace or withhold",async()=>{
  let response=wire();
  const client=fake(()=>response);
  let out=await hookCommand(client,post());
  assert.equal(out.kind,"deliver");
  assert.equal(out.output,"ok");
  assert.equal(client.calls.at(-1).boundary,"post");
  response=wire("allow",{updatedOutput:"[PII]"});
  out=await hookCommand(client,post());
  assert.equal(out.kind,"replace");
  assert.equal(out.output,"[PII]");
  response=wire("deny",{reason:"mask",updatedOutput:null});
  out=await hookCommand(client,post());
  assert.equal(out.kind,"replace");
  assert.equal(out.output,null);
  response=wire("deny",{reason:"block"});
  out=await hookCommand(client,post());
  assert.equal(out.kind,"withhold");
  assert.match(out.reason,/withheld/);
  assert.match(out.reason,/block/);
  assert.equal(out.output,undefined);
  response=wire("unavailable",{reason:"gone",retryable:false});
  assert.equal((await hookCommand(client,post())).kind,"withhold");
  response=wire();
  assert.equal((await hookCommand(client,post({tool_response:{b:1,a:[1,2]}}))).kind,"deliver");
});

test("lifecycle events are acknowledged or refused; the version check runs only on request",async()=>{
  let response=wire();
  const client=fake(()=>response);
  let out=await hookCommand(client,codex("SessionStart",{source:"startup"}),{checkVersion:true});
  assert.equal(out.kind,"acknowledged");
  assert.equal(client.versions,1);
  assert.equal(client.calls.at(-1).event,"session-start");
  assert.equal(client.calls.at(-1).boundary,"lifecycle");
  out=await hookCommand(client,codex("SessionEnd",{reason:"other"}));
  assert.equal(out.kind,"acknowledged");
  assert.equal(client.versions,1);
  assert.equal(client.calls.at(-1).event,"session-end");
  response=wire("deny",{reason:"session refused",operatorMessage:"warn"});
  out=await hookCommand(client,codex("SessionStart"));
  assert.equal(out.kind,"refuse");
  assert.match(out.reason,/session refused/);
  assert.equal(out.operatorMessage,"warn");
  response=wire("allow",{operatorMessage:"failed to bind session identity"});
  out=await hookCommand(client,codex("SessionStart",{source:"resume"}));
  assert.equal(out.kind,"acknowledged");
  assert.equal(out.operatorMessage,"failed to bind session identity");
});

test("transport failure is a refusal at every boundary, never an allow",async()=>{
  const client={async checkVersion() {},async decide() {throw new Unavailable("Hook transport failed");}};
  assert.equal((await hookCommand(client,pre())).kind,"refuse");
  assert.equal((await hookCommand(client,post())).kind,"withhold");
  const life=await hookCommand(client,codex("SessionStart",{source:"startup"}));
  assert.equal(life.kind,"refuse");
  assert.equal(life.decision,undefined);
  assert.match(life.reason,/transport failed/);
  let decided=0;
  const incompatible={async checkVersion() {throw new Unavailable("incompatible");},async decide() {decided++;}};
  assert.equal((await hookCommand(incompatible,codex("SessionStart"),{checkVersion:true})).kind,"refuse");
  assert.equal(decided,0);
  const broken={async decide() {throw new TypeError("host bug");}};
  await assert.rejects(hookCommand(broken,pre()),TypeError);
});

test("unsupported or malformed events are refused before the Hook is consulted",async()=>{
  const client=fake(()=>wire());
  await assert.rejects(hookCommand(client,codex("Stop")),Refused);
  await assert.rejects(hookCommand(client,codex("UserPromptSubmit",{prompt:"x"})),Refused);
  await assert.rejects(hookCommand(client,{...pre(),hook_event_name:42}),Refused);
  await assert.rejects(hookCommand(client,{...pre(),hook_event_name:"__proto__"}),Refused);
  await assert.rejects(hookCommand(client,"not an object"),Unavailable);
  await assert.rejects(hookCommand(client,[pre()]),Unavailable);
  await assert.rejects(hookCommand(client,pre({tool_input:{x:Infinity}})),Unavailable);
  const {tool_use_id:_call,...withoutCall}=pre();
  await assert.rejects(hookCommand(client,withoutCall),TypeError);
  await assert.rejects(hookCommand(client,pre({tool_use_id:""})),TypeError);
  await assert.rejects(hookCommand(client,pre({tool_input:"printf"})),TypeError);
  await assert.rejects(hookCommand(client,pre({tool_input:["printf"]})),TypeError);
  const {tool_response:_response,...withoutResponse}=post();
  await assert.rejects(hookCommand(client,withoutResponse),TypeError);
  const {session_id:_session,...withoutSession}=pre();
  await assert.rejects(hookCommand(client,withoutSession),TypeError);
  await assert.rejects(hookCommand(client,codex("SessionStart",{session_id:""})),TypeError);
  assert.equal(client.calls.length,0);
  assert.equal(client.versions,0);
});

test("only canonical event fields reach the Hook and the outcome is an isolated snapshot",async()=>{
  const client=fake(()=>wire());
  const payload=pre({prompt:"ignored",expansion_type:"skill",transcript_path:"/tmp/t.jsonl",agent_id:"sub-1",agent_type:"explorer",extra:{deep:true}});
  const out=await hookCommand(client,payload);
  const sent=client.calls[0].request;
  assert.deepEqual(Object.keys(sent).sort(),["agent_id","agent_type","cwd","hook_event_name","session_id","tool_input","tool_name","tool_use_id"]);
  assert.equal(sent.hook_event_name,"PreToolUse");
  assert.equal(sent.agent_id,"sub-1");
  payload.tool_input.command="changed after the decision";
  assert.deepEqual(out.input,{command:"printf ok"});
  assert.throws(()=>{out.kind="mutated";},TypeError);
});

async function fixture(t,source,timeoutMs=5000) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),"isonapse-adk-hook-command-")));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,"isonapse-hook");
  const bytes=Buffer.from(`#!${process.execPath}\n${source}`);
  await writeFile(path,bytes,{mode:0o700});
  return new Client(new InstalledHook(path,createHash("sha256").update(bytes).digest("hex")),"adk-codex-test",{timeoutMs});
}

test("the helper drives the shipped transport end to end",{timeout:30000},async t=>{
  const client=await fixture(t,`
    const argv=process.argv.slice(2);
    if (argv[1]!=="--host"||argv[2]!=="adk-codex-test"||argv[3]!=="--adapter-protocol"||argv[4]!=="1") process.exit(9);
    let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{
      const e=JSON.parse(raw);
      if (argv[0]==="pre-tool-use") {
        const denied=e.tool_input.command.includes("curl");
        console.log(JSON.stringify({protocolVersion:1,decision:denied?"deny":"allow",...(denied?{reason:"fixture denial"}:{effectiveInput:{command:e.tool_input.command+" --safe"}})}));
      } else if (argv[0]==="post-tool-use") console.log(JSON.stringify({protocolVersion:1,decision:"deny",reason:"fixture withhold"}));
      else console.log(JSON.stringify({protocolVersion:1,decision:"allow",operatorMessage:"event "+argv[0]+" "+e.hook_event_name}));
    });`);
  const started=await hookCommand(client,codex("SessionStart",{source:"startup"}));
  assert.equal(started.kind,"acknowledged");
  assert.equal(started.operatorMessage,"event session-start SessionStart");
  const rewrite=await hookCommand(client,pre());
  assert.equal(rewrite.kind,"rewrite");
  assert.deepEqual(rewrite.input,{command:"printf ok --safe"});
  const deny=await hookCommand(client,pre({tool_input:{command:"curl x"}}));
  assert.equal(deny.kind,"refuse");
  assert.match(deny.reason,/fixture denial/);
  assert.equal((await hookCommand(client,post())).kind,"withhold");
  const crash=await fixture(t,"process.exit(9)");
  assert.equal((await hookCommand(crash,pre())).kind,"refuse");
  assert.equal((await hookCommand(crash,post())).kind,"withhold");
  assert.equal((await hookCommand(crash,codex("SessionEnd",{reason:"other"}))).kind,"refuse");
});

test("the client's per-exchange timeout bounds the version probe and the decision alike, so a two-exchange SessionStart stays inside a host deadline",{timeout:20000},async t=>{
  // A hook-command host gives SessionStart one deadline for BOTH exchanges
  // (Codex: 60 s). A Hook that answers `--version` but never answers the
  // decision, and one that never answers at all, must each give up at the
  // client's timeoutMs, never the 50 s package maximum. The test's own 20 s
  // limit is the deadline pin: one ignored budget runs past it.
  const hangsOnDecision=await fixture(t,`
    if (process.argv[2]==="--version") {console.log("isonapse-hook 0.3.0");process.exit(0);}
    setInterval(()=>{},1000);`,400);
  let out=await hookCommand(hangsOnDecision,codex("SessionStart",{source:"startup"}),{checkVersion:true});
  assert.equal(out.kind,"refuse");
  assert.match(out.reason,/exceeded its budget/);
  assert.equal(out.decision,undefined);
  const hangsOnProbe=await fixture(t,"setInterval(()=>{},1000);",400);
  out=await hookCommand(hangsOnProbe,codex("SessionStart",{source:"startup"}),{checkVersion:true});
  assert.equal(out.kind,"refuse");
  assert.match(out.reason,/exceeded its budget/);
  // The tool events are one bounded exchange each on the same client.
  assert.equal((await hookCommand(hangsOnProbe,pre())).kind,"refuse");
  assert.equal((await hookCommand(hangsOnProbe,post())).kind,"withhold");
  // A budget above the package maximum is refused at the exchange, never
  // silently capped, so an adapter constant cannot exceed the transport deadline.
  const over=await fixture(t,`console.log("isonapse-hook 0.3.0");`,50001);
  out=await hookCommand(over,codex("SessionStart",{source:"startup"}),{checkVersion:true});
  assert.equal(out.kind,"refuse");
  assert.match(out.reason,/budget invalid/);
});

// #929 messaging: an outcome names `cause` exactly when the Hook gave no
// decision, so an adapter can tell an identity, transport or protocol refusal
// (never fixed by retrying) from a Hook decision. One negative per class.
test("#929 refusals without a Hook decision carry their cause class; Hook decisions never do",{timeout:30000},async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"isonapse-adk-cause-")));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const hook=async(name,source,mode=0o700,parent=directory)=>{
    const path=join(parent,name), bytes=Buffer.from(`#!${process.execPath}\n${source}`);
    await writeFile(path,bytes); await chmod(path,mode);
    return {path,pin:createHash("sha256").update(bytes).digest("hex")};
  };
  const answer=value=>`process.stdin.resume();process.stdin.on("end",()=>console.log(${JSON.stringify(value)}));`;
  const allow=await hook("allow",answer(wire()));
  await mkdir(join(directory,"world"),{mode:0o700}); await chmod(join(directory,"world"),0o777);
  const exposed=await hook("exposed",answer(wire()),0o700,join(directory,"world"));
  const crash=await hook("crash","process.exit(9)"), garbage=await hook("garbage",answer("not json"));
  const client=(path,pin)=>new Client(new InstalledHook(path,pin),"adk-codex-test",{timeoutMs:5000});
  const P="Installed Hook identity could not be verified";
  const refusals=[
    ["pin mismatch",client(allow.path,"0".repeat(64)),"hook-identity:pin-mismatch",`${P} (pin mismatch): the Hook binary does not match the configured SHA-256 pin. After an Isonapse upgrade, recompute the pin from hook_binary_path, update the hook definition and re-trust it.`],
    ["untrusted path",client(exposed.path,exposed.pin),"hook-identity:untrusted-path",`${P} (untrusted path): a directory on the Hook path is world-writable and not a root-owned sticky directory.`],
    ["missing Hook",client(join(directory,"absent"),allow.pin),"hook-identity:missing",`${P} (Hook missing): nothing exists at the configured Hook path; check hook_binary_path in the Isonapse configuration.`],
    ["invalid configuration",client("relative/isonapse-hook",allow.pin),"hook-identity:invalid-configuration",`${P} (invalid configuration): the Hook path must be absolute and the pin must be 64 lowercase hexadecimal characters.`],
    ["transport",client(crash.path,crash.pin),"hook-transport","Hook transport failed, cancelled or exceeded its budget"],
    ["protocol",client(garbage.path,garbage.pin),"hook-protocol","Invalid or incompatible Hook Protocol v1 response"],
  ];
  for (const [label,subject,cause,reason] of refusals) {
    for (const [payload,kind] of [[pre(),"refuse"],[post(),"withhold"],[codex("SessionEnd",{reason:"other"}),"refuse"]]) {
      const out=await hookCommand(subject,payload);
      assert.equal(out.kind,kind,`${label} ${payload.hook_event_name}`);
      assert.equal(out.cause,cause,`${label} ${payload.hook_event_name}`);
      assert.equal(out.reason,reason,`${label} ${payload.hook_event_name}`);
      assert.equal(out.decision,undefined,`${label}: no Hook decision exists`);
    }
  }
  // changed: the Hook file is replaced (same bytes) between the walk and the open.
  const require=createRequire(import.meta.url), fsp=require("node:fs/promises"), open=fsp.open;
  const swapped=await hook("swapped",answer(wire()));
  fsp.open=async(path,...rest)=>{
    if (String(path)===swapped.path) {await hook("swapped.new",answer(wire())); await rename(swapped.path+".new",swapped.path);}
    return open(path,...rest);
  };
  syncBuiltinESMExports();
  let changed;
  try {changed=await hookCommand(client(swapped.path,swapped.pin),pre());}
  finally {fsp.open=open; syncBuiltinESMExports();}
  assert.equal(changed.kind,"refuse");
  assert.equal(changed.cause,"hook-identity:changed");
  assert.equal(changed.reason,`${P} (changed during verification): the Hook path or file changed while it was being verified, for example during an upgrade.`);
  // The version probe is a protocol check too.
  const old=await hook("old",`console.log("isonapse-hook 0.2.9")`);
  const probed=await hookCommand(client(old.path,old.pin),codex("SessionStart",{source:"startup"}),{checkVersion:true});
  assert.deepEqual([probed.kind,probed.cause,probed.reason],["refuse","hook-protocol","Installed Hook version is incompatible with ADK v1"]);
  // Every Hook decision that refuses keeps its decision and has no cause.
  for (const [label,response,kind] of [
    ["deny",wire("deny",{reason:"policy says no"}),"refuse"],
    ["ask without approval",wire("ask",{reason:"review"}),"refuse"],
    ["unavailable decision",wire("unavailable",{reason:"control-plane-unavailable",retryable:true}),"refuse"],
  ]) {
    const decided=await hook(`decided-${label.replaceAll(" ","-")}`,answer(response));
    const out=await hookCommand(client(decided.path,decided.pin),pre());
    assert.equal(out.kind,kind,label);
    assert.equal(out.cause,undefined,label);
    assert.equal(out.decision.decision,JSON.parse(response).decision,label);
  }
  const fine=await hookCommand(client(allow.path,allow.pin),pre());
  assert.equal(fine.kind,"proceed");
  assert.equal(fine.cause,undefined);
});
