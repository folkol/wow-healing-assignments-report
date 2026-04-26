import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const serverPath = resolve(root, "dist/server.js");

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
      }
    } catch {
      console.log("[srv:raw]", line);
    }
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[srv:stderr] ${c}`));

let idc = 0;
function rpc(method, params) {
  const id = ++idc;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`timeout ${method}`)), 60_000);
  });
}

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-counterfactual", version: "0.0.1" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

const tools = await rpc("tools/list", {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
console.log("[smoke] tools:", names.join(", "));

const r = await rpc("tools/call", {
  name: "wcl_counterfactual_ability_avoidance",
  arguments: {
    reportCode: "jhTnt7Hw81fLFDyr",
    encounterName: "Vorasius",
    abilityPattern: "Aftershock",
    windowSeconds: 6,
  },
});
const text = r.result?.content?.[0]?.text ?? "(empty)";
const parsed = JSON.parse(text);
console.log("\nsummary:", parsed.summary);
console.log("matchedAbilities:", parsed.matchedAbilities);
console.log("totals:", {
  total: parsed.totalDeaths,
  wipe: parsed.wipeDeaths,
  nonWipe: parsed.nonWipeDeaths,
  hitTotal: parsed.deathsHitTotal,
  hitNonWipe: parsed.deathsHitNonWipe,
});
console.log("top impacted players (first 5):");
for (const p of parsed.perPlayer.slice(0, 5)) console.log(` ${p.name}: ${p.nonWipeDeathsHit} non-wipe / ${p.deathsHit} total / ${p.totalDeaths} deaths`);

child.stdin.end();
await once(child, "exit");
