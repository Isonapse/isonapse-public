#!/usr/bin/env node
import {writeFile} from "node:fs/promises";

const starter = `// Review and register this exact entrypoint before running.
import {resolve} from "node:path";
import {parseArgs} from "node:util";
import {Client,InstalledHook} from "@isonapse/hook-adk";
import {Runtime} from "@isonapse/hook-adk/runtime";
const {values} = parseArgs({options:{hook:{type:"string"},"hook-sha256":{type:"string"},host:{type:"string"},session:{type:"string"},file:{type:"string"}}});
for (const name of ["hook","hook-sha256","host","session","file"]) if (!values[name]) throw Error("Missing operator setting: " + name);
// Settings are operator-owned; never accept them from model tool arguments.
const runtime = new Runtime(new Client(new InstalledHook(values.hook,values["hook-sha256"]),values.host), values.session, process.cwd(), {notify:message=>console.error(message)});
await runtime.start();
const result = await runtime.tool("read-1","Read",{file_path:resolve(values.file)},async input=>{
  const {open} = await import("node:fs/promises");
  const file=await open(input.file_path,"r");
  try {
    const buffer=Buffer.alloc(65537);
    const {bytesRead}=await file.read(buffer,0,buffer.length,0);
    if (bytesRead>65536) throw Error("example file exceeds 64 KiB");
    return new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,bytesRead));
  } finally {await file.close();}
});
console.log(result);
await runtime.end();
`;
if (process.argv.length !== 4 || process.argv[2] !== "init") {
  console.error("Usage: isonapse-hook-adk init <new-starter.mjs>");
  process.exitCode = 2;
} else {
  await writeFile(process.argv[3], starter, {encoding:"utf8", flag:"wx", mode:0o600});
  console.log("Created native Read callback. Review, then use isonapse hook host-profile create/validate/register.");
}
