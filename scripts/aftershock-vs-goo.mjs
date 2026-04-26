import { getReportMeta, fetchAllEvents } from "../dist/wcl/client.js";

const REPORT = "jhTnt7Hw81fLFDyr";
const meta = await getReportMeta(REPORT);

// Find candidate abilities
const cands = meta.abilities.filter((a) =>
  /aftershock|goo|kl[aä]gg|slime|ooze|sludge/i.test(a.name ?? ""),
);
console.log("Candidate abilities:");
for (const a of cands) console.log(`  ${a.gameID}  ${a.name}`);
console.log();

// Consider all Vorasius fights
const vFights = meta.fights.filter((f) => f.name === "Vorasius");
const start = Math.min(...vFights.map((f) => f.startTime));
const end = Math.max(...vFights.map((f) => f.endTime));
const fightIDs = vFights.map((f) => f.id);

const dmg = await fetchAllEvents({
  code: REPORT,
  startTime: start,
  endTime: end,
  fightIDs,
  dataType: "DamageTaken",
  hostilityType: "Friendlies",
});

function analyzeByPredicate(pred, label) {
  const events = dmg.filter((e) => pred(e.abilityGameID ?? e.ability?.guid, e));
  if (events.length === 0) {
    console.log(`${label}: no events`);
    return;
  }

  // Group by target, find peak sliding 3s window.
  const byTarget = new Map();
  for (const e of events) {
    const a = byTarget.get(e.targetID) ?? [];
    a.push(e);
    byTarget.set(e.targetID, a);
  }
  let bestWindow = 0;
  let bestPerTargetAvg = 0;
  const perTargetPeaks = [];
  const hitDamages = [];
  for (const [tid, arr] of byTarget) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
    let peak = 0;
    for (let i = 0; i < arr.length; i++) {
      let sum = 0;
      for (let j = i; j < arr.length && arr[j].timestamp - arr[i].timestamp <= 3000; j++) {
        sum += (arr[j].amount ?? 0) + (arr[j].absorbed ?? 0);
      }
      if (sum > peak) peak = sum;
    }
    perTargetPeaks.push({ tid, peak });
    hitDamages.push(...arr.map((e) => (e.amount ?? 0) + (e.absorbed ?? 0)));
    if (peak > bestWindow) bestWindow = peak;
  }
  perTargetPeaks.sort((a, b) => b.peak - a.peak);
  bestPerTargetAvg =
    perTargetPeaks.reduce((s, p) => s + p.peak, 0) / perTargetPeaks.length;

  // Tick rate estimate: median inter-tick interval for a single target
  const intervals = [];
  for (const arr of byTarget.values()) {
    for (let i = 1; i < arr.length; i++) intervals.push(arr[i].timestamp - arr[i - 1].timestamp);
  }
  intervals.sort((a, b) => a - b);
  const medianInterval = intervals[Math.floor(intervals.length / 2)] ?? 0;

  // Sort hits for median
  hitDamages.sort((a, b) => a - b);
  const medHit = hitDamages[Math.floor(hitDamages.length / 2)] ?? 0;

  console.log(`${label}`);
  console.log(`  total events: ${events.length}, targets hit: ${byTarget.size}`);
  console.log(`  median hit: ${Math.round(medHit).toLocaleString()}, median tick interval: ${medianInterval}ms`);
  console.log(`  PEAK 3s window on one target: ${Math.round(bestWindow).toLocaleString()}`);
  console.log(`  avg of each target's peak 3s window: ${Math.round(bestPerTargetAvg).toLocaleString()}`);
  console.log(`  top 5 target peaks:`);
  for (const p of perTargetPeaks.slice(0, 5)) {
    const name = meta.actors.find((a) => a.id === p.tid)?.name ?? `#${p.tid}`;
    console.log(`    ${name}: ${Math.round(p.peak).toLocaleString()}`);
  }
  console.log();
}

const aftershockIDs = new Set(
  cands.filter((a) => a.name === "Aftershock").map((a) => a.gameID),
);
const gooIDs = new Set(cands.filter((a) => a.name === "Dark Goo").map((a) => a.gameID));

analyzeByPredicate((aid) => aftershockIDs.has(aid), "Aftershock (alla IDs sammanslagna)");
analyzeByPredicate((aid) => gooIDs.has(aid), "Dark Goo");

// Distribution across raid roles for Aftershock (prove it's not tank-only)
console.log("\nAftershock-träffar per spelare (visar att det är ringar, inte tank-smäll):");
const afterShockHits = dmg.filter((e) =>
  aftershockIDs.has(e.abilityGameID ?? e.ability?.guid),
);
const hitCountByTarget = new Map();
for (const e of afterShockHits) {
  hitCountByTarget.set(e.targetID, (hitCountByTarget.get(e.targetID) ?? 0) + 1);
}
const rows = [...hitCountByTarget.entries()]
  .map(([tid, n]) => {
    const a = meta.actors.find((x) => x.id === tid);
    return { name: a?.name ?? `#${tid}`, role: a?.subType ?? "?", hits: n };
  })
  .sort((a, b) => b.hits - a.hits);
for (const r of rows) console.log(`  ${String(r.hits).padStart(3)} × ${r.name} (${r.role})`);

// For comparison: Shadowclaw Slam (boss tank melee) — should be tank-heavy
console.log("\nShadowclaw Slam-träffar per spelare (till jämförelse; detta ÄR tank-smällen):");
const slamIDs = new Set(
  meta.abilities
    .filter((a) => a.name === "Shadowclaw Slam")
    .map((a) => a.gameID),
);
const slamHits = dmg.filter((e) => slamIDs.has(e.abilityGameID ?? e.ability?.guid));
const slamBy = new Map();
for (const e of slamHits) slamBy.set(e.targetID, (slamBy.get(e.targetID) ?? 0) + 1);
const slamRows = [...slamBy.entries()]
  .map(([tid, n]) => {
    const a = meta.actors.find((x) => x.id === tid);
    return { name: a?.name ?? `#${tid}`, role: a?.subType ?? "?", hits: n };
  })
  .sort((a, b) => b.hits - a.hits);
for (const r of slamRows.slice(0, 10))
  console.log(`  ${String(r.hits).padStart(4)} × ${r.name} (${r.role})`);
