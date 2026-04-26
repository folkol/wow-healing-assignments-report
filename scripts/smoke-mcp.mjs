import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const serverPath = resolve(root, "dist/server.js");

// Launch the MCP server from a different cwd to prove the env/code is robust
// to Cursor's "ignore cwd" behavior we saw in the log.
const child = spawn(process.execPath, [serverPath], {
  cwd: "C:/Users/folkol",
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      } else {
        console.log("[srv:notif]", msg);
      }
    } catch {
      console.log("[srv:raw]", line);
    }
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[srv:stderr] ${c}`));
child.on("exit", (code) => console.log(`[srv] exited code=${code}`));

let idc = 0;
function rpc(method, params) {
  const id = ++idc;
  const msg = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }
    }, 30_000);
  });
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-mcp", version: "0.0.1" },
});
console.log("[smoke] initialize:", init.result?.serverInfo ?? init);

child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

const tools = await rpc("tools/list", {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
console.log(`[smoke] tools (${names.length}):`, names.join(", "));

const resolved = await rpc("tools/call", {
  name: "wcl_resolve_guild",
  arguments: {},
});
console.log("[smoke] wcl_resolve_guild ->");
console.log(resolved.result?.content?.[0]?.text);

const listed = await rpc("tools/call", {
  name: "wcl_list_reports",
  arguments: { limit: 3 },
});
const text = listed.result?.content?.[0]?.text ?? "(no content)";
console.log("[smoke] wcl_list_reports -> first 400 chars:");
console.log(text.slice(0, 400));

child.stdin.end();
await once(child, "exit");
console.log("[smoke] OK");
