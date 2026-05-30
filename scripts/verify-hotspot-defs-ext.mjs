import { readFileSync } from "node:fs";
import { getReportMeta, fetchAllEvents } from "../src/wcl/client.ts";

const audit = JSON.parse(readFileSync("examples/crown-hotspot-deaths-audit.json", "utf8"));
const verify = JSON.parse(readFileSync("examples/crown-hotspot-def-verify.json", "utf8"));
const REPORT = "gTYPRBaKGVCf2Fbc";
const meta = await getReportMeta(REPORT);
const crownFights = meta.fights.filter((f) => f.encounterID === 3181);
const counter = new Map();
const fightByAttempt = new Map();
for (const f of crownFights) {
  const n = (counter.get(f.name) ?? 0) + 1;
  counter.set(f.name, n);
  fightByAttempt.set(n, f);
}
const actorByName = new Map(meta.actors.map((a) => [a.name, a]));
const abilityNames = new Map((meta.abilities ?? []).map((a) => [a.gameID, a.name]));
const deaths = await fetchAllEvents({
  code: REPORT,
  startTime: Math.min(...crownFights.map((f) => f.startTime)),
  endTime: Math.max(...crownFights.map((f) => f.endTime)),
  fightIDs: crownFights.map((f) => f.id),
  dataType: "Deaths",
  hostilityType: "Friendlies",
});
const DEF =
  /shield|wall|stand|defens|fortif|bark|skin|survival|dispersion|cloak|feint|evasion|icebound|vampir|anti-magic|spell reflect|darkness|blur|nether|desperate|pain sup|guardian spirit|ironbark|renewal|bear form|turtle|unending|dark pact|ice block|invisibility|divine|ardent|astral|diffuse|dampen|obsidian|healthstone|potion|phial|rallying|regenerat|frenzied|dream of|tranquil|barrier|spirit link|zephyr|stasis|time dilation|life cocoon|sacrifice|hand of|rally/i;

const castsCache = new Map();
async function getCasts(pid) {
  if (!castsCache.has(pid)) {
    castsCache.set(
      pid,
      await fetchAllEvents({
        code: REPORT,
        startTime: 0,
        endTime: meta.endTime - meta.startTime,
        dataType: "Casts",
        hostilityType: "Friendlies",
        sourceID: pid,
      }),
    );
  }
  return castsCache.get(pid);
}

const potHealRows = verify.filter((r) => r.potHeals5s.length);
console.log("=== Pot/healing consumable in 5s (heal events) ===");
for (const r of potHealRows) {
  console.log(`P${r.pull} ${r.time} ${r.player}: ${r.potHeals5s.join(", ")} (audit pots: ${r.auditPots})`);
}

const def30 = [];
for (const row of audit.rows) {
  const actor = actorByName.get(row.player);
  const fight = fightByAttempt.get(row.pull);
  const [m, s] = row.time.split(":").map(Number);
  const match = deaths.find(
    (d) =>
      d.targetID === actor.id &&
      d.fight === fight.id &&
      Math.abs((d.timestamp - fight.startTime) / 1000 - (m * 60 + s)) < 2,
  );
  if (!match) continue;
  const ts = match.timestamp;
  const c30 = (await getCasts(actor.id)).filter((c) => c.timestamp > ts - 30000 && c.timestamp <= ts);
  const defLike = c30
    .map((c) => c.ability?.name ?? abilityNames.get(c.abilityGameID))
    .filter((n) => n && DEF.test(n));
  if (defLike.length) {
    def30.push({
      player: row.player,
      pull: row.pull,
      time: row.time,
      defLike: [...new Set(defLike)],
      auditDef5s: row.defUsed5s,
    });
  }
}

console.log("\n=== Defensive-like CASTS in last 30s ===");
console.log("count:", def30.length, "/ 41");
for (const r of def30) {
  console.log(`P${r.pull} ${r.time} ${r.player}: ${r.defLike.join(", ")} | audit 5s: ${r.auditDef5s}`);
}

console.log("\n=== Summary ===");
console.log(
  JSON.stringify(
    {
      auditDefUsed5s: audit.rows.filter((r) => r.defUsed5s !== "none").length,
      auditPotsCast5s: audit.rows.filter((r) => r.potsUsed5s !== "none").length,
      potHealEvents5s: potHealRows.length,
      defLikeCasts30s: def30.length,
      noDefLikeCasts30s: 41 - def30.length,
    },
    null,
    2,
  ),
);
