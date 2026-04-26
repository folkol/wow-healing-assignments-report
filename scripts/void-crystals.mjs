import { getReportMeta, fetchAllEvents } from "../dist/wcl/client.js";
import { gql } from "../dist/wcl/graphql.js";

const REPORT = "jhTnt7Hw81fLFDyr";
const meta = await getReportMeta(REPORT);
const kill = meta.fights.find((f) => f.name === "Vorasius" && f.kill);

const data = await gql(
  `query Q($code:String!){reportData{report(code:$code){masterData{actors(type:"NPC"){id gameID name subType}}}}}`,
  { code: REPORT },
);
const npcs = data.reportData.report.masterData.actors;
const crystals = npcs.filter((n) => n.name === "Void Crystal");
console.log(`Void Crystal actor instances in report: ${crystals.length}`);
console.log(`Unique gameIDs: ${[...new Set(crystals.map((c) => c.gameID))].join(", ")}\n`);

// All events where Void Crystal is involved in the kill fight
const abilityByID = new Map(meta.abilities.map((a) => [a.gameID, a.name]));

// What do void crystals cast?
const casts = await fetchAllEvents({
  code: REPORT,
  startTime: kill.startTime,
  endTime: kill.endTime,
  fightIDs: [kill.id],
  dataType: "Casts",
  hostilityType: "Enemies",
});
const crystalIDs = new Set(crystals.map((c) => c.id));
const crystalCasts = casts.filter((c) => crystalIDs.has(c.sourceID));
console.log(`Casts BY Void Crystals on kill pull: ${crystalCasts.length}`);
const byAbil = new Map();
for (const c of crystalCasts) {
  const aid = c.abilityGameID ?? c.ability?.guid;
  byAbil.set(aid, (byAbil.get(aid) ?? 0) + 1);
}
for (const [aid, n] of [...byAbil.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n} × ${abilityByID.get(aid) ?? `#${aid}`}`);
}

// What buffs/debuffs are applied BY void crystals? These are usually auras on the boss/players.
const debuffs = await fetchAllEvents({
  code: REPORT,
  startTime: kill.startTime,
  endTime: kill.endTime,
  fightIDs: [kill.id],
  dataType: "Debuffs",
  hostilityType: "Enemies",
});
const crystalDebuffs = debuffs.filter((d) => crystalIDs.has(d.sourceID));
console.log(`\nDebuffs applied BY Void Crystals: ${crystalDebuffs.length}`);
const byDebuff = new Map();
for (const d of crystalDebuffs) {
  if (d.type !== "applydebuff" && d.type !== "applybuff") continue;
  const aid = d.abilityGameID ?? d.ability?.guid;
  byDebuff.set(aid, (byDebuff.get(aid) ?? 0) + 1);
}
for (const [aid, n] of [...byDebuff.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n} × ${abilityByID.get(aid) ?? `#${aid}`}`);
}

// Damage they take — to understand their HP / kill timing
const dmgTaken = await fetchAllEvents({
  code: REPORT,
  startTime: kill.startTime,
  endTime: kill.endTime,
  fightIDs: [kill.id],
  dataType: "DamageDone",
  hostilityType: "Friendlies",
});
const crystalDmg = dmgTaken.filter((e) => crystalIDs.has(e.targetID));
let totalDmg = 0;
let firstHit = Infinity;
let lastHit = -Infinity;
for (const e of crystalDmg) {
  totalDmg += (e.amount ?? 0) + (e.absorbed ?? 0);
  firstHit = Math.min(firstHit, e.timestamp);
  lastHit = Math.max(lastHit, e.timestamp);
}
console.log(
  `\nTotal dmg dealt to Void Crystals on kill pull: ${totalDmg.toLocaleString()} across ${crystalDmg.length} hits`,
);
console.log(
  `First crystal damaged ${((firstHit - kill.startTime) / 1000).toFixed(1)}s into fight, last at ${((lastHit - kill.startTime) / 1000).toFixed(1)}s`,
);

// Look at enemy deaths to see when crystals died
const deaths = await fetchAllEvents({
  code: REPORT,
  startTime: kill.startTime,
  endTime: kill.endTime,
  fightIDs: [kill.id],
  dataType: "Deaths",
  hostilityType: "Enemies",
});
const crystalDeaths = deaths.filter((d) => crystalIDs.has(d.targetID));
console.log(`\nVoid Crystals killed: ${crystalDeaths.length}`);
// Try to pull x/y from both damage and death events
const coords = [];
for (const e of [...crystalDmg, ...crystalDeaths]) {
  if (typeof e.x === "number" && typeof e.y === "number") {
    coords.push({ x: e.x, y: e.y, gameID: npcByID.get(e.targetID)?.gameID });
  }
}
// Also try CombatantInfo / all events for crystals
if (coords.length === 0) {
  console.log("  (no x/y on damage/death events — sampling raw shape)");
  console.log("  sample death event keys:", Object.keys(crystalDeaths[0] ?? {}).join(", "));
  console.log("  sample damage event keys:", Object.keys(crystalDmg[0] ?? {}).join(", "));
  console.log("  sample damage event:", JSON.stringify(crystalDmg[0], null, 2));
}
if (coords.length) {
  const xs = coords.map((c) => c.x);
  const ys = coords.map((c) => c.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  console.log(
    `  X range: ${xMin}..${xMax} (span ${xMax - xMin}), Y range: ${yMin}..${yMax} (span ${yMax - yMin})`,
  );
  // Bucket into a 5x5 grid to see distribution
  const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
  for (const c of coords) {
    const cx = Math.min(4, Math.floor(((c.x - xMin) / (xMax - xMin || 1)) * 5));
    const cy = Math.min(4, Math.floor(((c.y - yMin) / (yMax - yMin || 1)) * 5));
    grid[4 - cy][cx] += 1;
  }
  console.log("  Spatial distribution (5x5 grid, top-left = high-y/low-x):");
  for (const row of grid) console.log("   ", row.map((n) => String(n).padStart(3)).join(" "));

  // Per gameID, show coord range and a few samples
  const byGame = new Map();
  for (const c of coords) {
    const a = byGame.get(c.gameID) ?? [];
    a.push(c);
    byGame.set(c.gameID, a);
  }
  for (const [gid, arr] of byGame.entries()) {
    const xs2 = arr.map((c) => c.x);
    const ys2 = arr.map((c) => c.y);
    console.log(
      `  gameID ${gid}: n=${arr.length} x[${Math.min(...xs2)}..${Math.max(...xs2)}] y[${Math.min(...ys2)}..${Math.max(...ys2)}]`,
    );
  }
}
const firstDeathT = ((crystalDeaths[0]?.timestamp ?? 0) - kill.startTime) / 1000;
const lastDeathT = ((crystalDeaths.at(-1)?.timestamp ?? 0) - kill.startTime) / 1000;
console.log(
  `  first death ${firstDeathT.toFixed(1)}s, last death ${lastDeathT.toFixed(1)}s`,
);

// Who killed them? Source players.
const playerBySourceID = new Map(
  meta.actors.filter((a) => a.type === "Player").map((a) => [a.id, a]),
);
const killsByPlayer = new Map();
for (const e of crystalDmg) {
  const name = playerBySourceID.get(e.sourceID)?.name ?? `#${e.sourceID}`;
  killsByPlayer.set(name, (killsByPlayer.get(name) ?? 0) + 1);
}
console.log(`\nHits per player on Void Crystals:`);
for (const [name, n] of [...killsByPlayer.entries()].sort((a, b) => b[1] - a[1])) {
  const cls = meta.actors.find((a) => a.name === name)?.subType ?? "?";
  console.log(`  ${n} × ${name} (${cls})`);
}

// Any buff appearing on players when a crystal dies? (soak signature)
// Also: what abilities do the crystals correlate with (boss cast right before spawn)?
const bossCasts = casts.filter(
  (c) => !crystalIDs.has(c.sourceID) && typeof c.sourceID === "number",
);
console.log(`\nBoss/enemy casts on kill pull: ${bossCasts.length}`);
const castAbilityCounts = new Map();
for (const c of bossCasts) {
  const aid = c.abilityGameID ?? c.ability?.guid;
  castAbilityCounts.set(aid, (castAbilityCounts.get(aid) ?? 0) + 1);
}
console.log(`Top 12 enemy abilities:`);
for (const [aid, n] of [...castAbilityCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${n} × ${abilityByID.get(aid) ?? `#${aid}`}`);
}
