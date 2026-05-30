/**
 * Validate def/pot detection — scan ALL casts, buffs, heals in 5s pre-death window.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getReportMeta, fetchAllEvents } from "../src/wcl/client.ts";

const REPORT = "gTYPRBaKGVCf2Fbc";
const WINDOW_MS = 5000;

const DEF_NAME = /shield wall|last stand|defens|fortif|barkskin|survival|dispersion|cloak|feint|evasion|icebound|vampiric|anti-magic|spell reflect|darkness|blur|netherwalk|desperate prayer|pain sup|guardian spirit|ironbark|renewal|bear form|aspect of the turtle|unending resolve|dark pact|ice block|greater invisibility|divine shield|divine protection|ardent|astral shift|diffuse magic|dampen harm|obsidian|renewing blaze|healthstone|potion|phial|rallying cry|survival of the fittest|fueled by violence|enraged regen|healing draught/i;

const audit = JSON.parse(readFileSync("examples/crown-hotspot-deaths-audit.json", "utf8"));
const meta = await getReportMeta(REPORT);
const abilityNames = new Map((meta.abilities ?? []).map((a) => [a.gameID, a.name]));
const fightByID = new Map(meta.fights.filter((f) => f.encounterID === 3181).map((f) => [f.id, f]));
const actorByName = new Map(meta.actors.map((a) => [a.name, a]));

const crownFights = meta.fights.filter((f) => f.encounterID === 3181);
const deaths = await fetchAllEvents({
  code: REPORT,
  startTime: Math.min(...crownFights.map((f) => f.startTime)),
  endTime: Math.max(...crownFights.map((f) => f.endTime)),
  fightIDs: crownFights.map((f) => f.id),
  dataType: "Deaths",
  hostilityType: "Friendlies",
});

const attemptIndexByFightID = new Map();
{
  const counter = new Map();
  for (const f of crownFights) {
    const n = (counter.get(f.name) ?? 0) + 1;
    counter.set(f.name, n);
    attemptIndexByFightID.set(f.id, n);
  }
}
const fightByAttempt = new Map();
for (const f of crownFights) {
  fightByAttempt.set(attemptIndexByFightID.get(f.id), f);
}

const auditDeaths = [];
for (const row of audit.rows) {
  const actor = actorByName.get(row.player);
  const fight = fightByAttempt.get(row.pull);
  if (!actor || !fight) continue;
  const [m, s] = row.time.split(":").map(Number);
  const targetSec = m * 60 + s;
  const match = deaths.find((d) => {
    if (d.targetID !== actor.id || d.fight !== fight.id) return false;
    const sec = (d.timestamp - fight.startTime) / 1000;
    return Math.abs(sec - targetSec) < 2;
  });
  if (!match) continue;
  auditDeaths.push({ row, actor, fight, timestamp: match.timestamp });
}

console.error(`Matched ${auditDeaths.length}/${audit.rows.length} deaths to timestamps`);

const castsCache = new Map();
const buffsCache = new Map();
const healsCache = new Map();

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

async function getBuffs(pid, fight, ts) {
  const key = `${pid}|${fight.id}`;
  if (!buffsCache.has(key)) {
    buffsCache.set(
      key,
      await fetchAllEvents({
        code: REPORT,
        startTime: fight.startTime,
        endTime: fight.endTime,
        fightIDs: [fight.id],
        dataType: "Buffs",
        hostilityType: "Friendlies",
        targetID: pid,
      }),
    );
  }
  return buffsCache.get(key);
}

async function getHeals(pid, fight, ts) {
  const key = `${pid}|${fight.id}|${ts}`;
  if (!healsCache.has(key)) {
    healsCache.set(
      key,
      await fetchAllEvents({
        code: REPORT,
        startTime: ts - WINDOW_MS,
        endTime: ts,
        fightIDs: [fight.id],
        dataType: "Healing",
        hostilityType: "Friendlies",
        targetID: pid,
      }),
    );
  }
  return healsCache.get(key);
}

const results = [];
for (const { row, actor, fight, timestamp } of auditDeaths) {
  const casts = await getCasts(actor.id);
  const buffs = await getBuffs(actor.id, fight, timestamp);
  const heals = await getHeals(actor.id, fight, timestamp);

  const casts5s = casts.filter((c) => c.timestamp > timestamp - WINDOW_MS && c.timestamp <= timestamp);
  const defCasts5s = casts5s
    .map((c) => c.ability?.name ?? abilityNames.get(c.abilityGameID) ?? `#${c.abilityGameID}`)
    .filter((n) => n && DEF_NAME.test(n));

  const buffs5s = buffs.filter((b) => {
    if (b.timestamp <= timestamp - WINDOW_MS || b.timestamp > timestamp) return false;
    const t = b.type ?? "";
    return t.includes("apply") || t.includes("refresh");
  });
  const defBuffs5s = buffs5s
    .map((b) => b.ability?.name ?? abilityNames.get(b.abilityGameID))
    .filter((n) => n && DEF_NAME.test(n));

  const heals5s = heals.filter((h) => h.timestamp > timestamp - WINDOW_MS);
  const potHeals = heals5s
    .map((h) => h.ability?.name ?? abilityNames.get(h.abilityGameID))
    .filter((n) => n && DEF_NAME.test(n));

  const allCastNames5s = casts5s
    .map((c) => c.ability?.name ?? abilityNames.get(c.abilityGameID))
    .filter(Boolean);

  results.push({
    pull: row.pull,
    time: row.time,
    player: row.player,
    auditDefUsed: row.defUsed5s,
    auditPots: row.potsUsed5s,
    broadDefCasts5s: defCasts5s,
    broadDefBuffsApplied5s: defBuffs5s,
    potHeals5s: potHeals,
    castCount5s: casts5s.length,
    sampleCasts5s: allCastNames5s.slice(0, 8),
  });
  process.stderr.write(".");
}

console.error("\n");

const withBroadDefCast = results.filter((r) => r.broadDefCasts5s.length > 0);
const withBroadBuff = results.filter((r) => r.broadDefBuffsApplied5s.length > 0);
const withPotHeal = results.filter((r) => r.potHeals5s.length > 0);
const auditDefUsed = results.filter((r) => r.auditDefUsed !== "none");
const auditPots = results.filter((r) => r.auditPots !== "none");
const mismatchDef = results.filter(
  (r) => r.auditDefUsed === "none" && (r.broadDefCasts5s.length > 0 || r.broadDefBuffsApplied5s.length > 0),
);

console.log(
  JSON.stringify(
    {
      matched: results.length,
      auditDefUsed: auditDefUsed.length,
      auditPots: auditPots.length,
      broadDefCasts5s: withBroadDefCast.length,
      broadDefBuffsApplied5s: withBroadBuff.length,
      potHeals5s: withPotHeal.length,
      mismatchDefCount: mismatchDef.length,
      mismatchDefExamples: mismatchDef.slice(0, 15),
      allBroadDefCastExamples: withBroadDefCast.slice(0, 10),
    },
    null,
    2,
  ),
);

writeFileSync("examples/crown-hotspot-def-verify.json", JSON.stringify(results, null, 2));
