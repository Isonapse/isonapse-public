import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile, mkdir, symlink, rm, realpath, access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
const entry = process.env.ISONAPSE_ADK_TEST_PACKAGE || new URL("../index.js", import.meta.url).href;
const {Client, InstalledHook, Unavailable, decodeHostEvent, decode, snapshot, stringifyJson, execute, deliver} = await import(entry);
const {hookCommand} = await import(new URL("hook-command.js", entry));
const {Runtime} = await import(new URL("runtime.js", entry));
const {replaceExecutableInput} = await import(new URL("input.js", entry));
const vectors = JSON.parse(await readFile(new URL("../../conformance/vectors/json-integers.json", import.meta.url), "utf8"));
const event = input => `{"hook_event_name":"PreToolUse","session_id":"integers","cwd":"/work","tool_use_id":"call","tool_name":"mcp__example__update","tool_input":${input}}`;
const answer = effective => `{"protocolVersion":1,"decision":"allow"${effective === null ? "" : `,"effectiveInput":${effective}`}}`;

async function fixture(t, response) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "isonapse-adk-integers-")));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const request = join(directory, "request.json"), path = join(directory, "hook");
  // The fixture never parses or serializes the request/answer numbers. Its
  // capture therefore proves the library's wire bytes, not a second decoder.
  const source = Buffer.from(`#!${process.execPath}\nlet raw=''; process.stdin.on('data',c=>raw+=c); process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(request)},raw);process.stdout.write(${JSON.stringify(response)});});\n`);
  await writeFile(path, source, {mode:0o700});
  const pin = createHash("sha256").update(source).digest("hex");
  return {directory, request, path, pin, client:new Client(new InstalledHook(path,pin), "codex")};
}

async function codexResult(f, raw) {
  await mkdir(join(f.directory,"node_modules/@isonapse"),{recursive:true});
  await symlink(dirname(fileURLToPath(entry)), join(f.directory,"node_modules/@isonapse/hook-adk"));
  const adapter = join(f.directory,"codex_hook.mjs");
  await writeFile(adapter, await readFile(new URL("../../reference/codex/codex_hook.mjs",import.meta.url)));
  const child = execFile(process.execPath,[adapter,"--hook",f.path,"--hook-sha256",f.pin,"--host","codex"],{timeout:10000});
  child.stdin.end(raw);
  return new Promise((resolve,reject) => {
    let stdout="",stderr="";child.stdout.on("data",c=>stdout+=c);child.stderr.on("data",c=>stderr+=c);
    child.on("error",reject);child.on("close",code=>resolve({code,stdout,stderr}));
  });
}

test("shared integer vectors keep the exact host input, effective input and outcome", async t => {
  for (const row of vectors.accepted) {
    const f = await fixture(t, answer(row.effective));
    const payload = decodeHostEvent(event(row.input));
    const out = await hookCommand(f.client, payload);
    assert.equal(out.kind, row.kind, row.name);
    assert.ok((await readFile(f.request,"utf8")).includes(`"tool_input":${row.input}`), `${row.name}: exact request bytes`);
    assert.equal(stringifyJson(out.input), row.effective ?? row.input, `${row.name}: exact selected input`);
    assert.equal(stringifyJson(snapshot(payload.tool_input)), row.input, `${row.name}: snapshot must stay exact`);
    if (row.name === "odd-integer") assert.equal(payload.tool_input.account_id, 9007199254740993n);
  }
});

test("the maintained Codex renderer forwards and rewrites the shared integer vectors exactly", async t => {
  for (const row of vectors.accepted) {
    const f = await fixture(t, answer(row.effective));
    const result = await codexResult(f,event(row.input));
    assert.equal(result.code, 0, `${row.name}: ${result.stderr}`);
    assert.ok((await readFile(f.request,"utf8")).includes(`"tool_input":${row.input}`), `${row.name}: Codex request bytes`);
    if (row.kind === "proceed") assert.equal(result.stdout,"",row.name);
    else assert.equal(result.stdout,`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":${row.effective}}}`,row.name);
  }
});

test("shared unrepresentable integers refuse at both decode boundaries and before transport", async t => {
  for (const row of vectors.refused) {
    const input = `{"account_id":${row.value}}`;
    assert.throws(()=>decodeHostEvent(event(input)),Unavailable,`${row.name}: host`);
    assert.throws(()=>decode(answer(input),"pre"),{code:"hook-protocol"},`${row.name}: Hook`);
    const f = await fixture(t, answer(input));
    const out = await hookCommand(f.client, decodeHostEvent(event('{"account_id":1}')));
    assert.equal(out.kind,"refuse",row.name);
    assert.equal(out.cause,"hook-protocol",row.name);
    assert.equal(out.input,undefined,row.name);
    const hostFixture = await fixture(t,answer(null));
    const hostRefusal = await codexResult(hostFixture,event(input));
    assert.equal(hostRefusal.code,2,`${row.name}: Codex refuses an unreadable host event`);
    assert.match(hostRefusal.stderr,/action was not authorized/);
    await assert.rejects(access(hostFixture.request));
    const hookFixture = await fixture(t,answer(input));
    const hookRefusal = await codexResult(hookFixture,event('{"account_id":1}'));
    assert.equal(hookRefusal.code,0);
    assert.match(hookRefusal.stdout,/"permissionDecision":"deny"/);
    assert.ok(!hookRefusal.stdout.includes('"updatedInput"'));
    await assert.rejects(f.client.decide("pre-tool-use",{session_id:"s",tool_use_id:"c",tool_input:{id:1n<<64n}},{boundary:"pre"}),Unavailable);
  }
});

test("already unsafe Numbers cannot reach a client or native effect; ordinary numbers keep working", async t => {
  for (const raw of ["9007199254740993.0","9.007199254740993e15"]) {
    assert.throws(()=>decodeHostEvent(event(`{"id":${raw}}`)),Unavailable);
    assert.throws(()=>decode(answer(`{"id":${raw}}`),"pre"),{code:"hook-protocol"});
  }
  const f = await fixture(t, answer(null));
  const payload = decodeHostEvent(event('{"account_id":1}'));
  payload.tool_input.account_id = Number("9007199254740993");
  await assert.rejects(hookCommand(f.client,payload),Unavailable);
  await assert.rejects(access(f.request));
  let calls=0,effects=0;
  const runtime = new Runtime({decide:async()=>{calls++;return decode(answer(null),"pre");}},"s","/work",{notify:()=>{}});
  await assert.rejects(runtime.tool("c","MCP",{account_id:Number("9007199254740993")},()=>{effects++;}),Unavailable);
  assert.equal(calls,0);assert.equal(effects,0);
  for (const value of [NaN,Infinity,-Infinity,1n<<64n,-(1n<<63n)-1n]) {
    assert.throws(()=>snapshot({id:value}),Unavailable);
    assert.throws(()=>stringifyJson({id:value}),Unavailable);
  }
  assert.deepEqual(snapshot({id:42,fraction:1.5,text:"9007199254740993"}),{id:42,fraction:1.5,text:"9007199254740993"});
});

test("an incapable native replacement seam refuses bigint before mutating executable input",()=>{
  const target={original:true};
  assert.match(replaceExecutableInput(target,{nested:[{id:9007199254740993n}]}),/cannot apply an exact bigint/);
  assert.deepEqual(target,{original:true});
  assert.equal(replaceExecutableInput(target,{id:42}),undefined);
  assert.deepEqual(target,{id:42});
});

test("big integers retain boundary binding, refusal and exact output replacement",async()=>{
  let effects=0;
  const input='{"account_id":9007199254740993}';
  for (const decision of ["deny","ask","unavailable"]) {
    const raw=`{"protocolVersion":1,"decision":"${decision}","reason":"refused"${decision==="unavailable"?',"retryable":false':''}}`;
    await assert.rejects(execute(decode(raw,"pre"),decodeHostEvent(input),()=>{effects++;}));
  }
  assert.equal(effects,0);
  const selected = await execute(decode(answer(input),"pre"),{},value=>value);
  assert.equal(stringifyJson(selected),input);
  const output=deliver(decode(`{"protocolVersion":1,"decision":"allow","updatedOutput":${input}}`,"post"),{});
  assert.equal(stringifyJson(output),input);
  assert.throws(()=>decodeHostEvent('{"id":9007199254740993,"id":1}'),Unavailable);
});

test("missing lossless JSON support refuses large integers without affecting safe values",()=>{
  const originalParse=JSON.parse, originalRaw=JSON.rawJSON;
  try {
    JSON.parse=text=>originalParse(text);
    assert.throws(()=>decodeHostEvent('{"id":9007199254740993}'),Unavailable);
    assert.deepEqual(decodeHostEvent('{"id":42}'),{id:42});
    JSON.parse=originalParse;
    JSON.rawJSON=undefined;
    assert.throws(()=>snapshot({id:9007199254740993n}),Unavailable);
    assert.throws(()=>stringifyJson({id:9007199254740993n}),Unavailable);
    assert.equal(stringifyJson({id:42}),'{"id":42}');
  } finally {JSON.parse=originalParse;JSON.rawJSON=originalRaw;}
});


test("Codex permitted policy context survives original and rewritten calls 1176", async t => {
  const context = "User policy is not loaded after a startup failure";
  for (const effective of [null, '{"account_id":4}']) {
    const response = JSON.stringify({protocolVersion:1,decision:"allow",additionalContext:context,operatorMessage:"operator-only note",...(effective ? {effectiveInput:JSON.parse(effective)} : {})});
    const f = await fixture(t,response);
    const result = await codexResult(f,event('{"account_id":3}'));
    assert.equal(result.code,0,result.stderr);
    const wire = JSON.parse(result.stdout);
    assert.equal(wire.hookSpecificOutput.permissionDecision,"allow");
    assert.equal(wire.hookSpecificOutput.additionalContext,context);
    assert.equal(wire.systemMessage,"operator-only note");
    assert.ok(!wire.hookSpecificOutput.additionalContext.includes("operator-only"));
    if (effective) assert.deepEqual(wire.hookSpecificOutput.updatedInput,{account_id:4});
  }
});
