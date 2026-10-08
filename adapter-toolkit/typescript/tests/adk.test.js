import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,chmod,chown,rm,symlink,link,unlink,rename,realpath,readFile,readlink,lstat,open} from "node:fs/promises";
import {createRequire,syncBuiltinESMExports} from "node:module";
import {setTimeout as delay} from "node:timers/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
const require=createRequire(import.meta.url);
const {Client,InstalledHook,Unavailable,Refused,decode,execute,deliver} =
  await import(process.env.ISONAPSE_ADK_TEST_PACKAGE ?? "../index.js");
const wire=(decision="allow",fields={})=>JSON.stringify({protocolVersion:1,decision,...fields});

test("exact rewrites reach the native effect, refusals never do",async()=>{
  const effects=[];
  await execute(decode(wire("allow",{effectiveInput:{path:"approved"}}),"pre"),{path:"original",secret:"remove"},input=>effects.push(input));
  assert.deepEqual(effects,[{path:"approved"}]);
  for (const kind of ["deny","ask","unavailable"]) {
    const fields={reason:"review",...(kind==="unavailable"?{retryable:true}:{})};
    await assert.rejects(execute(decode(wire(kind,fields),"pre"),{},input=>effects.push(input)),Refused);
  }
  assert.equal(effects.length,1);
  await execute(decode(wire("ask",{reason:"review",effectiveInput:{approved:true}}),"pre"),{},input=>effects.push(input),{approve:()=>true});
  assert.deepEqual(effects[1],{approved:true});
});
test("strict known fields, duplicate keys and boundary mismatch refuse",()=>{
  for(const raw of ['{"protocolVersion":1,"decision":"deny","decision":"allow"}',wire("allow",{effectiveInput:[]}),wire("allow",{reason:"bad"}),wire("unavailable",{reason:"missing retry"}),wire("deny"),wire("allow",{updatedOutput:"bad"}),'[]',wire().slice(0,-1),' {"protocolVersion":true,"decision":"allow"}',wire("allow",{effectiveInput:{nested:[{}]}}).replace('"nested":','"a":0,"a":1,"nested":')]) {
    assert.throws(()=>decode(raw,"pre"),Unavailable);
  }
  assert.equal(decode(wire("allow",{extension:{opaque:true}}),"pre").decision,"allow");
  assert.equal(deliver(decode(wire("deny",{reason:"mask",updatedOutput:null}),"post"),"private"),null);
  assert.throws(()=>deliver(decode(wire("deny",{reason:"block"}),"post"),"private"),Refused);
});
test("cross-boundary and forged decisions cannot deliver effects",async()=>{
  for (const boundary of ["post","lifecycle"]) {
    await assert.rejects(execute(decode(wire(),boundary),{},()=>assert.fail("wrong boundary executed")),Refused);
  }
  await assert.rejects(execute({decision:"allow"},{},()=>assert.fail("forged decision executed")),Refused);
  assert.throws(()=>deliver(decode(wire(),"pre"),"private"),Refused);
});
async function fixture(t,source,timeoutMs=2000) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),"isonapse-adk-test-")));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,"isonapse-hook");
  const bytes=Buffer.from(`#!${process.execPath}\n${source}`);
  await writeFile(path,bytes,{mode:0o700});
  return new Client(new InstalledHook(path,createHash("sha256").update(bytes).digest("hex")),"pi",{timeoutMs});
}
const call=(client,options={})=>client.decide("tool_call",{session_id:"session",tool_use_id:"call"},{boundary:"pre",...options});
test("real transport and version handshake",async t=>{
  const client=await fixture(t,`if(process.argv.includes('--version')) console.log('isonapse-hook 0.3.0-beta+test.abc'); else {process.stdin.resume();process.stdin.on('end',()=>console.log('${wire()}'));}`);
  assert.match(await client.checkVersion(),/0\.3\.0/);
  assert.equal((await call(client)).decision,"allow");
});
test("version probing gives an immediate-exit child no request pipe",async t=>{
  const client=await fixture(t,`if(!require('node:fs').fstatSync(0).isCharacterDevice()) process.exit(9); console.log('isonapse-hook 0.3.0-beta');`);
  assert.equal(await client.checkVersion(),"isonapse-hook 0.3.0-beta");
});
test("crash, hang, overflow, cancellation and changed binary refuse",async t=>{
  for(const source of ['process.exit(9)','setInterval(()=>{},1000)','console.log("x".repeat(1024*1024+1))','process.stderr.write("x".repeat(70000))']) {
    await assert.rejects(call(await fixture(t,source,200)),Unavailable);
  }
  const client=await fixture(t,'process.exit(9)');
  assert.throws(()=>{client.installed.path="/bin/echo";},TypeError);
  assert.throws(()=>{client.host="claude-code";},TypeError);
  const abort=new AbortController();abort.abort();
  await assert.rejects(call(client,{signal:abort.signal}),{code:"hook-transport"});
  // #929: each refusal names its cause; none reaches the Hook process.
  await chmod(client.installed.path,0o722);
  await assert.rejects(call(client),{code:"hook-identity:untrusted-path",message:untrustedText("file")});
  await chmod(client.installed.path,0o700);
  // #929 changed the contract: a link the caller owns, in a directory that
  // passes, is followed, and verify() returns the real target it hashed.
  const alias=client.installed.path+"-link"; await symlink(client.installed.path,alias);
  assert.equal(await new InstalledHook(alias,client.installed.sha256).verify(),client.installed.path);
  await writeFile(client.installed.path,"changed");
  await assert.rejects(call(client),{code:"hook-identity:pin-mismatch",message:IDENTITY_TEXT["pin-mismatch"]});
});

// ---------------------------------------------------------------------------
// #929: the installed-Hook trust rule (option A). The same case names and
// expected causes are pinned in python/tests/test_adk.py.
// ---------------------------------------------------------------------------
const IDENTITY="Installed Hook identity could not be verified";
const RULES={
  owner:"an entry on the Hook path is not owned by you or root",
  "world-writable":"a directory on the Hook path is world-writable and not a root-owned sticky directory",
  "group-writable":"a directory on the Hook path is group-writable by a group other than macOS admin or your private Linux group",
  links:"the Hook path has more than 8 symbolic links",
  "not-a-directory":"a component of the Hook path is not a directory",
  file:"the Hook is not a regular file of at most 1 GiB owned by you or root and writable only by its owner",
};
const IDENTITY_TEXT={
  "pin-mismatch":`${IDENTITY} (pin mismatch): the Hook binary does not match the configured SHA-256 pin. After an Isonapse upgrade, recompute the pin from hook_binary_path, update the hook definition and re-trust it.`,
  missing:`${IDENTITY} (Hook missing): nothing exists at the configured Hook path; check hook_binary_path in the Isonapse configuration.`,
  changed:`${IDENTITY} (changed during verification): the Hook path or file changed while it was being verified, for example during an upgrade.`,
  "invalid-configuration":`${IDENTITY} (invalid configuration): the Hook path must be absolute and the pin must be 64 lowercase hexadecimal characters.`,
};
// The pin-file causes (pinned identically in python/tests/test_adk.py).
const PIN_FIX="Run isonapse hook adk-pin and use the pin file it names.";
const PIN_RULES={
  owner:"an entry on the pin file path is not owned by you or root",
  "world-writable":"a directory on the pin file path is world-writable and not a root-owned sticky directory",
  "group-writable":"a directory on the pin file path is group-writable by a group other than macOS admin or your private Linux group",
  links:"the pin file path has more than 8 symbolic links",
  "not-a-directory":"a component of the pin file path is not a directory",
  file:"the pin file is not a regular file owned by you or root and writable only by its owner",
};
IDENTITY_TEXT["pin-file-missing"]=`${IDENTITY} (pin file missing): nothing exists at the configured pin file path. ${PIN_FIX}`;
IDENTITY_TEXT["pin-file-invalid"]=`${IDENTITY} (pin file invalid): the pin file path must be absolute and the file must hold exactly one SHA-256 as 64 lowercase hexadecimal characters. ${PIN_FIX}`;
const PIN_FILE_MISMATCH=`${IDENTITY} (pin mismatch): the Hook binary does not match the SHA-256 in the pin file. After an Isonapse upgrade, run isonapse hook adk-pin; the hook definition does not change.`;
function untrustedText(rule) {return `${IDENTITY} (untrusted path): ${RULES[rule]}.`;}
// "ok" or a cause; "untrusted-path:<rule>" and "pin-file-untrusted:<rule>"
// name the rule text as well; "pin-file-mismatch" is the pin-mismatch code
// with the pin-file text.
function expected(outcome) {
  if (outcome.startsWith("untrusted-path:")) return {code:"hook-identity:untrusted-path",message:untrustedText(outcome.slice(15))};
  if (outcome.startsWith("pin-file-untrusted:")) return {code:"hook-identity:pin-file-untrusted",message:`${IDENTITY} (pin file untrusted): ${PIN_RULES[outcome.slice(19)]}. ${PIN_FIX}`};
  if (outcome==="pin-file-mismatch") return {code:"hook-identity:pin-mismatch",message:PIN_FILE_MISMATCH};
  return {code:`hook-identity:${outcome}`,message:IDENTITY_TEXT[outcome]};
}
async function verdict(path,pin,installed=new InstalledHook(path,pin)) {
  try {return {ok:await installed.verify()};}
  catch (error) {
    assert.ok(error instanceof Unavailable,`${error}`);
    return {code:error.code,message:error.message};
  }
}
async function assertVerdict(label,path,pin,outcome,okPath) {
  const got=await verdict(path,pin);
  if (outcome==="ok") assert.deepEqual(got,{ok:okPath},label);
  else assert.deepEqual(got,expected(outcome),label);
}
// The same, with the pin read from a pin file.
async function assertPinVerdict(label,path,pinFile,outcome,okPath) {
  const got=await verdict(path,undefined,InstalledHook.fromPinFile(path,pinFile));
  if (outcome==="ok") assert.deepEqual(got,{ok:okPath},label);
  else assert.deepEqual(got,expected(outcome),label);
}
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const hookSource=marker=>Buffer.from(`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({protocolVersion:1,decision:"deny",reason:${JSON.stringify(marker)}+" ran as "+process.argv[1]})));\n`);
const GENUINE=hookSource("genuine"), IMPOSTOR=hookSource("impostor");
const groups=process.getgroups();
const uid=process.geteuid();
// The one group the rule trusts, when the caller can actually use it here.
const TRUSTED_GROUP=process.platform==="darwin" ? (groups.includes(80) ? 80 : null)
  : process.platform==="linux" && process.getegid()===uid ? uid : null;
// A group the caller can chgrp to that the rule must refuse.
const OTHER_GROUP=groups.find(group=>group!==80 && group!==TRUSTED_GROUP) ?? null;
async function scratch(t) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),"isonapse-adk-verify-")));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}
async function directory(path,mode=0o755,group=null) {
  await mkdir(path,{recursive:true});
  if (group!==null) await chown(path,uid,group);
  await chmod(path,mode);
}
async function file(path,bytes,mode=0o555) {
  await writeFile(path,bytes);
  await chmod(path,mode);
}
// A Homebrew-shaped prefix: bin/ and opt/ links into a Cellar keg whose file
// is 0555. bin/, opt/ and Cellar/ take `group` with mode 0775 when given.
async function homebrew(t,{group=null,bytes=GENUINE}={}) {
  const base=await scratch(t), prefix=join(base,"hb");
  await directory(prefix);
  for (const name of ["bin","opt","Cellar"]) await directory(join(prefix,name),group===null ? 0o755 : 0o775,group);
  for (const name of ["Cellar/isonapse","Cellar/isonapse/1.0","Cellar/isonapse/1.0/bin"]) await directory(join(prefix,name));
  const hook=join(prefix,"Cellar/isonapse/1.0/bin/isonapse-hook");
  await file(hook,bytes);
  const binLink=join(prefix,"bin/isonapse-hook");
  await symlink("../Cellar/isonapse/1.0/bin/isonapse-hook",binLink);
  await symlink("../Cellar/isonapse/1.0",join(prefix,"opt/isonapse"));
  return {base,prefix,hook,link:binLink,opt:join(prefix,"opt/isonapse/bin/isonapse-hook"),pin:sha(bytes)};
}
// Path spellings resolved exactly alike by both packages (split on "/",
// drop "" and ".", resolve ".." against the real directory reached).
const spellings=L=>[
  ["bin link (the recorded Homebrew hook_binary_path)",L.link,"ok"],
  ["keg path",L.hook,"ok"],
  ["opt link ancestor",L.opt,"ok"],
  ["doubled slashes and dots","/"+L.prefix+"//bin/./isonapse-hook","ok"],
  ["dot-dot after a real directory",`${L.prefix}/Cellar/../bin/isonapse-hook`,"ok"],
  ["dot-dot above the root",`/../..${L.link}`,"ok"],
  ["dot-dot through a link is physical, not lexical",`${L.prefix}/opt/isonapse/../1.0/bin/isonapse-hook`,"ok"],
  ["trailing dot-dot names a directory",`${L.prefix}/bin/..`,"untrusted-path:file"],
  ["the root itself","/","untrusted-path:file"],
  ["a missing entry",`${L.prefix}/bin/absent`,"missing"],
  ["a regular file used as a directory",`${L.hook}/isonapse-hook`,"untrusted-path:not-a-directory"],
];
// Inject behaviour into the builtin the package imports (live ESM binding).
const fsp=require("node:fs/promises"), childProcess=require("node:child_process"), fs=require("node:fs");
async function patched(module,name,wrap,body) {
  const original=module[name];
  module[name]=wrap(original);
  syncBuiltinESMExports();
  try {return await body();}
  finally {module[name]=original; syncBuiltinESMExports();}
}
// Real lstat results with some fields changed for one exact path.
function forge(path,fields,fired) {
  return original=>async(target,...rest)=>{
    const result=await original(target,...rest);
    if (String(target)!==path) return result;
    fired.count++;
    return Object.assign(result,fields);
  };
}

test("#929 Homebrew-shaped layout: owned links are followed and verify returns the keg path",async t=>{
  const L=await homebrew(t);
  for (const [label,path,outcome] of spellings(L)) await assertVerdict(label,path,L.pin,outcome,L.hook);
  await assertVerdict("wrong SHA through the link",L.link,"0".repeat(64),"pin-mismatch");
  // Test for the test: the accepted path really is a link, and the keg is 0555.
  assert.ok((await lstat(L.link)).isSymbolicLink());
  assert.equal((await lstat(L.hook)).mode & 0o777,0o555);
});

test("#929 trusted writer group: macOS admin or the Linux private group is accepted, any other group refused",async t=>{
  if (TRUSTED_GROUP!==null) {
    const L=await homebrew(t,{group:TRUSTED_GROUP});
    assert.equal((await lstat(join(L.prefix,"Cellar"))).mode & 0o777,0o775,"fixture: Cellar is group-writable");
    assert.equal((await lstat(join(L.prefix,"Cellar"))).gid,TRUSTED_GROUP);
    for (const path of [L.link,L.opt,L.hook]) await assertVerdict(`trusted group ${TRUSTED_GROUP}: ${path}`,path,L.pin,"ok",L.hook);
  } else {
    // Linux whose primary group is not a private group (gid != uid), or a
    // Mac account outside admin: the same layout must be refused.
    const group=process.platform==="linux" ? process.getegid() : OTHER_GROUP;
    assert.notEqual(group,null,"a group-writable fixture needs a group the caller can use");
    const L=await homebrew(t,{group});
    assert.equal((await lstat(join(L.prefix,"bin"))).gid,group);
    await assertVerdict(`group ${group} without the private-group condition`,L.link,L.pin,"untrusted-path:group-writable");
  }
  const L=await homebrew(t);
  if (OTHER_GROUP!==null) {
    for (const name of ["bin","Cellar"]) {
      await directory(join(L.prefix,name),0o775,OTHER_GROUP);
      assert.equal((await lstat(join(L.prefix,name))).gid,OTHER_GROUP);
      await assertVerdict(`${name} writable by group ${OTHER_GROUP}`,L.link,L.pin,"untrusted-path:group-writable");
      await directory(join(L.prefix,name),0o755);
    }
  } else {
    // INJECTED: no second group exists for this account, so the Cellar's real
    // lstat result is reported as writable by an unrelated group.
    const fired={count:0};
    await patched(fsp,"lstat",forge(join(L.prefix,"Cellar"),{mode:0o40775n,gid:4242n},fired),async()=>{
      await assertVerdict("Cellar writable by an unrelated group (injected)",L.link,L.pin,"untrusted-path:group-writable");
    });
    assert.ok(fired.count>0,"the injected lstat result was used");
  }
  await assertVerdict("restored layout",L.link,L.pin,"ok",L.hook);
});

test("#929 world-writable, sticky and foreign-owned ancestry is refused",async t=>{
  const base=await scratch(t);
  await directory(join(base,"ww"),0o777);
  await file(join(base,"ww/isonapse-hook"),GENUINE);
  await assertVerdict("world-writable non-sticky directory",join(base,"ww/isonapse-hook"),sha(GENUINE),"untrusted-path:world-writable");
  await directory(join(base,"sticky"),0o1777);
  await file(join(base,"sticky/isonapse-hook"),GENUINE);
  assert.equal((await lstat(join(base,"sticky"))).mode & 0o7777,0o1777,"fixture: user-owned sticky directory");
  await assertVerdict("user-owned sticky directory",join(base,"sticky/isonapse-hook"),sha(GENUINE),"untrusted-path:world-writable");
  await directory(join(base,"good"));
  await symlink(join(base,"ww/isonapse-hook"),join(base,"good/into-ww"));
  await assertVerdict("owned link into a world-writable directory",join(base,"good/into-ww"),sha(GENUINE),"untrusted-path:world-writable");
  const L=await homebrew(t);
  // INJECTED ownership: a nonroot test cannot create another user's inode.
  const foreign=BigInt(uid+4242);
  for (const [label,path,outcome] of [
    ["link owned by another user",L.link,"untrusted-path:owner"],
    ["directory owned by another user",join(L.prefix,"Cellar"),"untrusted-path:owner"],
    ["Hook owned by another user",L.hook,"untrusted-path:file"],
    ["root-owned link is followed",L.link,"ok"],
    ["root-owned Hook is accepted",L.hook,"ok"],
  ]) {
    const fired={count:0};
    const owner=label.startsWith("root-owned") ? 0n : foreign;
    await patched(fsp,"lstat",forge(path,{uid:owner},fired),()=>assertVerdict(label,L.link,L.pin,outcome,L.hook));
    assert.ok(fired.count>0,`${label}: the injected lstat result was used`);
  }
  await assertVerdict("same layout without injection",L.link,L.pin,"ok",L.hook);
});

test("#929 links: hop limit, loops, dangling and non-UTF-8 targets",async t=>{
  const L=await homebrew(t);
  const chain=async(length,name)=>{
    let target=L.hook;
    for (let index=0;index<length;index++) {
      const next=join(L.base,`${name}-${index}`);
      await symlink(target,next);
      target=next;
    }
    return target;
  };
  await assertVerdict("8 links (the limit)",await chain(8,"eight"),L.pin,"ok",L.hook);
  await assertVerdict("9 links",await chain(9,"nine"),L.pin,"untrusted-path:links");
  await symlink(join(L.base,"loop-b"),join(L.base,"loop-a"));
  await symlink(join(L.base,"loop-a"),join(L.base,"loop-b"));
  await assertVerdict("link loop",join(L.base,"loop-a"),L.pin,"untrusted-path:links");
  await symlink(join(L.base,"absent"),join(L.base,"dangling"));
  await assertVerdict("dangling link",join(L.base,"dangling"),L.pin,"missing");
  // A target that is not UTF-8 is refused identically in both packages. The
  // decoy is what a lossy decoder would reach ("t\xff" -> "t�"): a pinned
  // Hook, so a lossy resolver would accept instead of refusing.
  const raw=join(L.base,"non-utf8");
  await symlink(Buffer.from([0x74,0xff,0x2f,0x68]),raw);
  await directory(join(L.base,"t�"));
  await file(join(L.base,"t�/h"),GENUINE);
  assert.deepEqual([...await readlink(raw,{encoding:"buffer"})],[0x74,0xff,0x2f,0x68],"fixture: raw target bytes");
  assert.equal(await readlink(raw),"t�/h","fixture: the lossy reading names the decoy");
  await assertVerdict("decoy reached directly",join(L.base,"t�/h"),L.pin,"ok",join(L.base,"t�/h"));
  await assertVerdict("non-UTF-8 link target",raw,L.pin,"missing");
  // A valid UTF-8 target that starts with a BOM names the BOM path, as the
  // kernel resolves it: a decoder that strips the BOM would reach "x/h".
  const bom=join(L.base,"bom-link");
  await symlink(Buffer.from([0xef,0xbb,0xbf,0x78,0x2f,0x68]),bom);
  await directory(join(L.base,"﻿x"));
  await file(join(L.base,"﻿x/h"),GENUINE);
  assert.deepEqual([...(await readlink(bom,{encoding:"buffer"})).subarray(0,3)],[0xef,0xbb,0xbf],"fixture: the target starts with a BOM");
  assert.equal(await realpath(bom),join(L.base,"﻿x/h"),"fixture: the kernel resolves the BOM path");
  await assertVerdict("BOM target, only the BOM path exists",bom,L.pin,"ok",join(L.base,"﻿x/h"));
  await directory(join(L.base,"x"));
  await file(join(L.base,"x/h"),GENUINE);
  await assertVerdict("BOM target beside a pinned decoy without the BOM",bom,L.pin,"ok",join(L.base,"﻿x/h"));
});

test("#929 the root directory itself must pass the directory rule (injected)",async t=>{
  const L=await homebrew(t);
  for (const [label,fields,outcome] of [
    ["world-writable non-sticky root",{mode:0o40777n,uid:0n},"untrusted-path:world-writable"],
    ["root owned by another user",{uid:BigInt(uid+4242)},"untrusted-path:owner"],
    ["root group-writable by an untrusted group",{mode:0o40775n,uid:0n,gid:4242n},"untrusted-path:group-writable"],
    ["root-owned sticky 1777 root is tolerated",{mode:0o41777n,uid:0n},"ok"],
  ]) {
    const fired={count:0};
    await patched(fsp,"lstat",forge("/",fields,fired),()=>assertVerdict(label,L.link,L.pin,outcome,L.hook));
    assert.ok(fired.count>0,`${label}: the injected lstat("/") result was used`);
  }
  await assertVerdict("the real root",L.link,L.pin,"ok",L.hook);
});

test("#929 a FIFO swapped in before the open is refused before any read",{timeout:10000},async t=>{
  // No writer: without O_NONBLOCK the open itself blocks (the test times out).
  let L=await homebrew(t);
  await patched(fsp,"open",original=>async(path,...rest)=>{
    if (String(path)===L.hook) {await unlink(L.hook); childProcess.execFileSync("mkfifo",[L.hook]);}
    return original(path,...rest);
  },()=>assertVerdict("FIFO without a writer",L.link,L.pin,"changed"));
  assert.ok((await lstat(L.hook)).isFIFO(),"the swap happened");
  // A live writer holding buffered bytes: a read would fail EAGAIN
  // ("missing"), so "changed" proves the inode is checked before reading.
  L=await homebrew(t);
  let writer;
  try {
    await patched(fsp,"open",original=>async(path,...rest)=>{
      if (String(path)===L.hook && writer===undefined) {
        await unlink(L.hook); childProcess.execFileSync("mkfifo",[L.hook]);
        writer=fs.openSync(L.hook,fs.constants.O_RDWR|fs.constants.O_NONBLOCK);
        fs.writeSync(writer,Buffer.from("0123456789"));
      }
      return original(path,...rest);
    },()=>assertVerdict("FIFO in place of the Hook",L.link,L.pin,"changed"));
    assert.ok((await lstat(L.hook)).isFIFO(),"the swap happened");
  } finally {if (writer!==undefined) fs.closeSync(writer);}
});

test("#929 a Hook touched in place after the walk is refused (same inode)",async t=>{
  // dev and ino are unchanged, so only the size/mtime binding sees it.
  const L=await homebrew(t);
  const ino=(await lstat(L.hook)).ino;
  await patched(fsp,"open",original=>async(path,...rest)=>{
    if (String(path)===L.hook) fs.utimesSync(L.hook,new Date(1000),new Date(1000));
    return original(path,...rest);
  },()=>assertVerdict("mtime changed between lstat and hashing",L.link,L.pin,"changed"));
  const after=await lstat(L.hook);
  assert.equal(after.ino,ino,"fixture: the same inode");
  assert.equal(after.mtimeMs,1000,"the touch happened");
  await assertVerdict("the touched Hook verifies on the next event",L.link,L.pin,"ok",L.hook);
});

test("#929 per-platform writer-group rule (simulated platform, ids and stats)",async t=>{
  const egid=process.getegid;
  const cases=[
    // [label, platform, egid, Cellar {uid,gid,mode}, outcome]
    ["Linux private group",              "linux", uid,   {uid,gid:uid,mode:0o40775},   "ok"],
    ["Linux group != uid (shared)",      "linux", uid,   {uid,gid:uid+1,mode:0o40775}, "untrusted-path:group-writable"],
    ["Linux root-owned, user's group",   "linux", uid,   {uid:0,gid:uid,mode:0o40775}, "untrusted-path:group-writable"],
    ["Linux egid != uid",                "linux", uid+1, {uid,gid:uid,mode:0o40775},   "untrusted-path:group-writable"],
    ["Linux gid 80 is not special",      "linux", uid,   {uid,gid:80,mode:0o40775},    "untrusted-path:group-writable"],
    ["Linux world-writable private",     "linux", uid,   {uid,gid:uid,mode:0o40777},   "untrusted-path:world-writable"],
    ["root-owned sticky 1777",           "linux", uid,   {uid:0,gid:0,mode:0o41777},   "ok"],
    ["macOS root:admin 0775",            "darwin",uid,   {uid:0,gid:80,mode:0o40775},  "ok"],
    ["macOS user:admin 0775",            "darwin",uid,   {uid,gid:80,mode:0o40775},    "ok"],
    ["macOS user:admin 0777",            "darwin",uid,   {uid,gid:80,mode:0o40777},    "untrusted-path:world-writable"],
    ["macOS staff",                      "darwin",uid,   {uid,gid:20,mode:0o40775},    "untrusted-path:group-writable"],
    ["macOS wheel",                      "darwin",uid,   {uid,gid:0,mode:0o40775},     "untrusted-path:group-writable"],
    ["macOS another user's admin dir",   "darwin",uid,   {uid:uid+1,gid:80,mode:0o40775},"untrusted-path:owner"],
    ["macOS private-group shape",        "darwin",uid,   {uid,gid:uid,mode:0o40775},   uid===80 ? "ok" : "untrusted-path:group-writable"],
    ["other platform",                   "freebsd",uid,  {uid,gid:uid,mode:0o40775},   "untrusted-path:group-writable"],
  ];
  const L=await homebrew(t);
  const cellar=join(L.prefix,"Cellar");
  const platform=Object.getOwnPropertyDescriptor(process,"platform");
  try {
    for (const [label,simulated,group,stats,outcome] of cases) {
      Object.defineProperty(process,"platform",{...platform,value:simulated});
      process.getegid=()=>group;
      const fired={count:0};
      const forged={uid:BigInt(stats.uid),gid:BigInt(stats.gid),mode:BigInt(stats.mode)};
      await patched(fsp,"lstat",forge(cellar,forged,fired),()=>assertVerdict(label,L.link,L.pin,outcome,L.hook));
      assert.ok(fired.count>0,`${label}: the forged Cellar was examined`);
    }
  } finally {
    Object.defineProperty(process,"platform",platform);
    process.getegid=egid;
  }
  assert.equal(process.platform,platform.value);
});

test("#929 leaf rule and configuration checks",async t=>{
  const base=await scratch(t);
  for (const [mode,label] of [[0o575,"group-writable Hook"],[0o557,"world-writable Hook"]]) {
    await file(join(base,`hook-${mode.toString(8)}`),GENUINE,mode);
    await assertVerdict(label,join(base,`hook-${mode.toString(8)}`),sha(GENUINE),"untrusted-path:file");
  }
  await directory(join(base,"leaf-dir"));
  await assertVerdict("directory as the Hook",join(base,"leaf-dir"),sha(GENUINE),"untrusted-path:file");
  const large=join(base,"large");
  const handle=await open(large,"w");
  await handle.truncate(1024*1024*1024+1); await handle.close(); await chmod(large,0o555);
  await assertVerdict("Hook over 1 GiB",large,sha(GENUINE),"untrusted-path:file");
  const L=await homebrew(t);
  for (const [label,path,pin] of [
    ["relative path","hb/bin/isonapse-hook",L.pin],
    ["uppercase pin",L.link,L.pin.toUpperCase()],
    ["short pin",L.link,L.pin.slice(1)],
    ["NUL in the path",`${L.link}\0x`,L.pin],
    ["path that is not well-formed Unicode",`${L.prefix}/\ud800`,L.pin],
    ["path that is not a string",42,L.pin],
    ["pin that is not a string",L.link,null],
  ]) await assertVerdict(label,path,pin,"invalid-configuration");
});

test("#929 hard link planted in bin/ and the upgrade cycle",async t=>{
  const L=await homebrew(t);
  const other=join(L.base,"owned-other"); await file(other,IMPOSTOR,0o755);
  await unlink(L.link); await link(other,L.link);
  assert.equal((await lstat(L.link)).ino,(await lstat(other)).ino,"fixture: bin/ holds a hard link");
  await assertVerdict("hard link to other bytes",L.link,L.pin,"pin-mismatch");
  await unlink(L.link); await link(L.hook,L.link);
  await assertVerdict("hard link to the pinned bytes gains nothing",L.link,L.pin,"ok",L.link);
  // brew upgrade: the link moves to a new keg with new bytes; the pin is stale.
  await unlink(L.link);
  await directory(join(L.prefix,"Cellar/isonapse/2.0/bin"));
  const next=join(L.prefix,"Cellar/isonapse/2.0/bin/isonapse-hook");
  await file(next,IMPOSTOR);
  await assertVerdict("mid-upgrade, link absent",L.link,L.pin,"missing");
  await symlink("../Cellar/isonapse/2.0/bin/isonapse-hook",L.link);
  await assertVerdict("after upgrade, stale pin, same path",L.link,L.pin,"pin-mismatch");
  await assertVerdict("after upgrade, re-pinned",L.link,sha(IMPOSTOR),"ok",next);
});

test("#929 races inside verify are detected (injected swaps)",async t=>{
  // I1: the bin link is retargeted after the walk, before the file is opened.
  // The new target holds the SAME bytes, so only the re-resolve can see it.
  let L=await homebrew(t);
  await directory(join(L.prefix,"Cellar/isonapse/2.0/bin"));
  await file(join(L.prefix,"Cellar/isonapse/2.0/bin/isonapse-hook"),GENUINE);
  await patched(fsp,"open",original=>async(path,...rest)=>{
    if (String(path)===L.hook) {await unlink(L.link); await symlink("../Cellar/isonapse/2.0/bin/isonapse-hook",L.link);}
    return original(path,...rest);
  },()=>assertVerdict("link retargeted after resolve",L.link,L.pin,"changed"));
  assert.equal(await readlink(L.link),"../Cellar/isonapse/2.0/bin/isonapse-hook","the swap happened");
  // I2: the file is renamed over between lstat and open (same bytes again).
  L=await homebrew(t);
  const before=(await lstat(L.hook)).ino;
  await patched(fsp,"open",original=>async(path,...rest)=>{
    if (String(path)===L.hook) {await file(L.hook+".new",GENUINE); await rename(L.hook+".new",L.hook);}
    return original(path,...rest);
  },()=>assertVerdict("file replaced between lstat and open",L.link,L.pin,"changed"));
  assert.notEqual((await lstat(L.hook)).ino,before,"the replacement happened");
  // I4/I5: the file vanishes, or becomes a link, between the walk and the open.
  for (const [label,swap] of [
    ["file removed before the open",async()=>unlink(L.hook)],
    ["file replaced by a link before the open",async()=>{await rename(L.hook,L.hook+".real"); await symlink(L.hook+".real",L.hook);}],
  ]) {
    L=await homebrew(t);
    await patched(fsp,"open",original=>async(path,...rest)=>{
      if (String(path)===L.hook) await swap();
      return original(path,...rest);
    },()=>assertVerdict(label,L.link,L.pin,"changed"));
  }
  assert.ok((await lstat(L.hook)).isSymbolicLink(),"the last swap happened");
  // I3: the keg directory is swapped for a link once hashing is done.
  L=await homebrew(t);
  const keg=join(L.prefix,"Cellar/isonapse/1.0");
  let seen=0;
  await patched(fsp,"lstat",original=>async(path,...rest)=>{
    if (String(path)===keg && ++seen===2) {
      await rename(keg,keg+".old");
      await directory(join(L.prefix,"Cellar/isonapse/evil/bin"));
      await file(join(L.prefix,"Cellar/isonapse/evil/bin/isonapse-hook"),GENUINE);
      await symlink("evil",keg);
    }
    return original(path,...rest);
  },()=>assertVerdict("keg swapped after hashing",L.link,L.pin,"changed"));
  assert.equal(await readlink(keg),"evil","the swap happened");
  // I6: the link disappears once hashing is done (mid-upgrade): the second
  // walk fails, and that is reported as a change, not as a missing Hook.
  L=await homebrew(t);
  let walks=0;
  await patched(fsp,"lstat",original=>async(path,...rest)=>{
    if (String(path)===L.link && ++walks===2) await unlink(L.link);
    return original(path,...rest);
  },()=>assertVerdict("link removed after hashing",L.link,L.pin,"changed"));
  assert.equal(walks,2,"the second walk reached the link");
  await assertVerdict("the next event finds nothing",L.link,L.pin,"missing");
});

test("#929 the Client executes the verified real path, never the configured link",async t=>{
  const run=async(L,onSpawn)=>{
    const client=new Client(new InstalledHook(L.link,L.pin),"pi",{timeoutMs:5000});
    if (!onSpawn) return call(client);
    return patched(childProcess,"spawn",original=>(...args)=>{onSpawn(args[0]); return original(...args);},()=>call(client));
  };
  let L=await homebrew(t);
  assert.equal((await run(L)).reason,`genuine ran as ${L.hook}`);
  // Test for the test: executing the link itself reports the link, so the
  // assertion above really distinguishes the two paths.
  const direct=childProcess.spawnSync(L.link,{input:""});
  assert.ok(direct.stdout.toString().includes(`genuine ran as ${L.link}`),direct.stdout.toString());
  // Handled: a bin/ link swapped after verify() cannot change what runs.
  L=await homebrew(t);
  const impostor=join(L.base,"impostor"); await file(impostor,IMPOSTOR,0o755);
  let spawned;
  const decision=await run(L,executable=>{spawned=executable; fs.unlinkSync(L.link); fs.symlinkSync(impostor,L.link);});
  assert.equal(spawned,L.hook);
  assert.equal(decision.reason,`genuine ran as ${L.hook}`);
  assert.equal(await readlink(L.link),impostor,"the swap happened");
  await assertVerdict("the next event sees the swap",L.link,L.pin,"pin-mismatch");
  // Handled: the keg renamed away between verify() and exec is a transport refusal.
  L=await homebrew(t);
  let keg=join(L.prefix,"Cellar/isonapse/1.0");
  await assert.rejects(run(L,()=>fs.renameSync(keg,keg+".gone")),{code:"hook-transport"});
  assert.ok(fs.existsSync(keg+".gone"),"the rename happened");
  // RESIDUAL (documented, not closed): a writer of an accepted directory who
  // replaces the keg between verify() and exec runs other bytes for that one
  // event. Node has no fexecve. Pinned so closing it is a deliberate change.
  L=await homebrew(t);
  keg=join(L.prefix,"Cellar/isonapse/1.0");
  const residual=await run(L,()=>{
    fs.renameSync(keg,keg+".old"); fs.mkdirSync(join(keg,"bin"),{recursive:true});
    fs.writeFileSync(L.hook,IMPOSTOR); fs.chmodSync(L.hook,0o555);
  });
  assert.equal(residual.reason,`impostor ran as ${L.hook}`);
  await assertVerdict("the next event refuses the replaced keg",L.link,L.pin,"pin-mismatch");
});
// ---------------------------------------------------------------------------
// The pin file (--hook-sha256-file): read on every verification under the
// Hook path rule, never a link, exactly one lowercase SHA-256. The same case
// names and expected causes are pinned in python/tests/test_adk.py.
// ---------------------------------------------------------------------------
async function pinned(t,{content,mode=0o600}={}) {
  const L=await homebrew(t);
  const pins=join(L.base,"pins");
  await directory(pins,0o700);
  const pinFile=join(pins,"hook.sha256");
  await file(pinFile,Buffer.from(content ?? `${L.pin}\n`),mode);
  return {...L,pins,pinFile};
}

test("#929 pin file: a valid pin file is read and the link is followed to the keg",async t=>{
  const L=await pinned(t);
  await assertPinVerdict("pin with a trailing newline",L.link,L.pinFile,"ok",L.hook);
  await file(L.pinFile,Buffer.from(L.pin),0o600);
  await assertPinVerdict("pin without a trailing newline",L.link,L.pinFile,"ok",L.hook);
  await file(L.pinFile,Buffer.from(L.pin),0o400);
  await assertPinVerdict("read-only pin file",L.link,L.pinFile,"ok",L.hook);
  await chmod(L.pinFile,0o600);
  // Ancestors may be links under the Hook path rule; only the leaf may not.
  await symlink(L.pins,join(L.base,"pins-link"));
  await assertPinVerdict("owned link to the pin directory",L.link,join(L.base,"pins-link/hook.sha256"),"ok",L.hook);
  await file(L.pinFile,Buffer.from("0".repeat(64)+"\n"),0o600);
  await assertPinVerdict("stale pin (after an upgrade)",L.link,L.pinFile,"pin-file-mismatch");
  // Test for the test: the inline pin of the same bytes is accepted.
  await assertVerdict("the same Hook pinned inline",L.link,L.pin,"ok",L.hook);
});

test("#929 pin file: content must be exactly one lowercase SHA-256",async t=>{
  const L=await pinned(t);
  for (const [label,content] of [
    ["empty",""],
    ["two trailing newlines",`${L.pin}\n\n`],
    ["CRLF",`${L.pin}\r\n`],
    ["uppercase",L.pin.toUpperCase()],
    ["63 characters",L.pin.slice(1)],
    ["65 hex characters",`${L.pin}a`],
    ["a valid pin followed by more bytes",`${L.pin}\nx`],
    ["BOM-prefixed",`﻿${L.pin}`],
    ["NUL inside",`${L.pin.slice(0,63)}\0`],
    ["leading space",` ${L.pin}`],
    ["4 KiB",`${L.pin}\n`.repeat(63)],
  ]) {
    await file(L.pinFile,Buffer.from(content),0o600);
    await assertPinVerdict(label,L.link,L.pinFile,"pin-file-invalid");
  }
  // Test for the test: the same file with the valid pin is accepted again.
  await file(L.pinFile,Buffer.from(`${L.pin}\n`),0o600);
  await assertPinVerdict("restored",L.link,L.pinFile,"ok",L.hook);
});

test("#929 pin file: missing, link, mode, type and ancestry are refused",async t=>{
  const L=await pinned(t);
  await assertPinVerdict("missing pin file",L.link,join(L.pins,"absent"),"pin-file-missing");
  await assertPinVerdict("missing pin directory",L.link,join(L.base,"absent/hook.sha256"),"pin-file-missing");
  await symlink(L.pinFile,join(L.pins,"link.sha256"));
  assert.ok((await lstat(join(L.pins,"link.sha256"))).isSymbolicLink(),"fixture: the leaf is an owned link to a valid pin file");
  await assertPinVerdict("pin file that is a link",L.link,join(L.pins,"link.sha256"),"pin-file-untrusted:file");
  for (const mode of [0o620,0o602]) {
    await chmod(L.pinFile,mode);
    await assertPinVerdict(`pin file mode ${mode.toString(8)}`,L.link,L.pinFile,"pin-file-untrusted:file");
  }
  await chmod(L.pinFile,0o600);
  await directory(join(L.pins,"dir.sha256"));
  await assertPinVerdict("directory as the pin file",L.link,join(L.pins,"dir.sha256"),"pin-file-untrusted:file");
  childProcess.execFileSync("mkfifo",[join(L.pins,"fifo.sha256")]);
  await assertPinVerdict("FIFO as the pin file",L.link,join(L.pins,"fifo.sha256"),"pin-file-untrusted:file");
  await directory(join(L.base,"ww"),0o777);
  await file(join(L.base,"ww/hook.sha256"),Buffer.from(`${L.pin}\n`),0o600);
  await assertPinVerdict("pin file in a world-writable directory",L.link,join(L.base,"ww/hook.sha256"),"pin-file-untrusted:world-writable");
  await assertPinVerdict("pin file below a regular file",L.link,`${L.pinFile}/x`,"pin-file-untrusted:not-a-directory");
  // INJECTED ownership: a nonroot test cannot create another user's inode.
  for (const [label,path,owner,outcome] of [
    ["pin file owned by another user",L.pinFile,BigInt(uid+4242),"pin-file-untrusted:file"],
    ["pin directory owned by another user",L.pins,BigInt(uid+4242),"pin-file-untrusted:owner"],
    ["root-owned pin file is accepted",L.pinFile,0n,"ok"],
  ]) {
    const fired={count:0};
    await patched(fsp,"lstat",forge(path,{uid:owner},fired),()=>assertPinVerdict(label,L.link,L.pinFile,outcome,L.hook));
    assert.ok(fired.count>0,`${label}: the injected lstat result was used`);
  }
  await assertPinVerdict("same layout without injection",L.link,L.pinFile,"ok",L.hook);
});

test("#929 pin file: configuration and the pin source are validated",async t=>{
  const L=await pinned(t);
  for (const [label,pinFile] of [
    ["relative pin file path","pins/hook.sha256"],
    ["NUL in the pin file path",`${L.pinFile}\0x`],
    ["pin file path that is not well-formed Unicode",`${L.pins}/\ud800`],
    ["pin file path that is not a string",42],
  ]) await assertPinVerdict(label,L.link,pinFile,"pin-file-invalid");
  // Exactly one pin source: both, or neither, is a configuration error.
  assert.deepEqual(await verdict(L.link,undefined,new InstalledHook(L.link,L.pin,{sha256File:L.pinFile})),expected("invalid-configuration"),"both an inline pin and a pin file");
  assert.deepEqual(await verdict(L.link,undefined,new InstalledHook(L.link)),expected("invalid-configuration"),"no pin source");
  // The Hook path is still validated in pin-file mode.
  await assertPinVerdict("relative Hook path","hb/bin/isonapse-hook",L.pinFile,"invalid-configuration");
});

test("#929 pin file: a pin file replaced between the walk and the open is refused",async t=>{
  const L=await pinned(t);
  const before=(await lstat(L.pinFile)).ino;
  await patched(fsp,"open",original=>async(path,...rest)=>{
    if (String(path)===L.pinFile) {await file(L.pinFile+".new",Buffer.from(`${L.pin}\n`),0o600); await rename(L.pinFile+".new",L.pinFile);}
    return original(path,...rest);
  },()=>assertPinVerdict("pin file replaced after the walk",L.link,L.pinFile,"changed"));
  assert.notEqual((await lstat(L.pinFile)).ino,before,"the replacement happened");
  await assertPinVerdict("the replaced pin file verifies on the next event",L.link,L.pinFile,"ok",L.hook);
});

test("#929 pin file: the Client keeps the pin source and re-reads the pin file on every call",async t=>{
  const L=await pinned(t);
  const client=new Client(InstalledHook.fromPinFile(L.link,L.pinFile),"pi",{timeoutMs:5000});
  assert.equal(client.installed.sha256File,L.pinFile,"the Client's copy keeps the pin file");
  assert.equal(client.installed.sha256,undefined);
  assert.equal((await call(client)).reason,`genuine ran as ${L.hook}`);
  await file(L.pinFile,Buffer.from("0".repeat(64)+"\n"),0o600);
  await assert.rejects(call(client),{code:"hook-identity:pin-mismatch",message:PIN_FILE_MISMATCH});
  await file(L.pinFile,Buffer.from("not a pin\n"),0o600);
  await assert.rejects(call(client),expected("pin-file-invalid"));
  // Re-pinning (the upgrade cycle): the same Client, the same definition.
  await unlink(L.link);
  await directory(join(L.prefix,"Cellar/isonapse/2.0/bin"));
  const next=join(L.prefix,"Cellar/isonapse/2.0/bin/isonapse-hook");
  await file(next,IMPOSTOR);
  await symlink("../Cellar/isonapse/2.0/bin/isonapse-hook",L.link);
  await file(L.pinFile,Buffer.from(`${L.pin}\n`),0o600);
  await assert.rejects(call(client),{code:"hook-identity:pin-mismatch",message:PIN_FILE_MISMATCH});
  await file(L.pinFile,Buffer.from(`${sha(IMPOSTOR)}\n`),0o600);
  assert.equal((await call(client)).reason,`impostor ran as ${next}`);
});

test("cancellation closes local pipes even when a descendant escapes its process group",{timeout:10000},async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"isonapse-adk-holder-")));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const marker=join(directory,"pid");
  const code=`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const client=await fixture(t,`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(code)}],{detached:true,stdio:['ignore',1,2]});setInterval(()=>{},1000)`,5000);
  const abort=new AbortController();
  const result=assert.rejects(call(client,{signal:abort.signal}),Unavailable);
  let pid;
  try {
    for(let tries=0;tries<500;tries++) {
      try {pid=Number(await readFile(marker,'utf8'));break;} catch {await delay(10);}
    }
    assert.ok(Number.isInteger(pid)&&pid>1,"escaped pipe holder must actually start");
    abort.abort();
    await result;
    // It is intentionally outside the Hook process group. The ADK closes its
    // own descriptors; the test owns and removes this adversarial fixture.
    process.kill(pid,0);
  } finally {
    abort.abort();
    if(pid) try {process.kill(pid,"SIGKILL");} catch {}
  }
});
