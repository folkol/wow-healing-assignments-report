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
    setTimeout(() => reject(new Error(`timeout ${method}`)), 45_000);
  });
}

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-thursday", version: "0.0.1" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

// List reports for "last thursday"
const list = await rpc("tools/call", {
  name: "wcl_list_reports",
  arguments: { day: "last thursday", limit: 10 },
});
console.log("=== wcl_list_reports(day='last thursday') ===");
const listText = list.result?.content?.[0]?.text ?? "(empty)";
console.log(listText);

let parsed = {};
try {
  parsed = JSON.parse(listText);
} catch {}

const reportCode = parsed.reports?.[0]?.code;
if (!reportCode) {
  console.log("\n[smoke] no reports for last thursday, bailing.");
  child.stdin.end();
  await once(child, "exit");
  process.exit(0);
}

const fights = await rpc("tools/call", {
  name: "wcl_report_fights",
  arguments: { reportCode, encounterName: "Vorasius" },
});
console.log("\n=== wcl_report_fights (Vorasius) ===");
console.log(fights.result?.content?.[0]?.text?.slice(0, 1500) ?? "(empty)");

const analysis = await rpc("tools/call", {
  name: "wcl_analyze_death_window",
  arguments: {
    reportCode,
    encounterName: "Vorasius",
    windowSeconds: 6,
  },
});
console.log("\n=== wcl_analyze_death_window (Vorasius) ===");
const aText = analysis.result?.content?.[0]?.text ?? "(empty)";
try {
  const a = JSON.parse(aText);
  console.log("summary:", a.summary);
  console.log("totalDeaths:", a.totalDeaths);
  console.log("topAbilities (first 8):");
  for (const t of (a.topAbilities ?? []).slice(0, 8)) {
    console.log(
      `  - ${t.abilityName} (#${t.abilityID}): ${t.deathsImpacted}/${a.totalDeaths} (${t.pctOfDeaths.toFixed(0)}%) dmg=${t.totalDamage}`,
    );
  }
  console.log("deathsByPlayer:", a.deathsByPlayer);
} catch {
  console.log(aText.slice(0, 1500));
}

child.stdin.end();
await once(child, "exit");
