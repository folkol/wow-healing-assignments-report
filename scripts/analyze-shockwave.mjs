import { getReportMeta, fetchAllEvents } from "../dist/wcl/client.js";

const REPORT = "jhTnt7Hw81fLFDyr";
const WINDOW_MS = 6000;
// Cluster = >=N deaths within WINDOW seconds of each other => assumed called wipe.
const WIPE_MIN_DEATHS = 5;
const WIPE_WINDOW_MS = 10000;
// How far before the last death of a wipe cluster to include deaths as "wipe deaths".
const WIPE_LOOKBACK_MS = 15000;

const meta = await getReportMeta(REPORT);
const vFights = meta.fights.filter((f) => f.name === "Vorasius");
console.log(`[analyze] Vorasius fights: ${vFights.length}`);

const abilityName = new Map();
for (const a of meta.abilities) if (a.name) abilityName.set(a.gameID, a.name);

const startTime = Math.min(...vFights.map((f) => f.startTime));
const endTime = Math.max(...vFights.map((f) => f.endTime));
const fightIDs = vFights.map((f) => f.id);

const [deaths, damage] = await Promise.all([
  fetchAllEvents({
    code: REPORT,
    startTime,
    endTime,
    fightIDs,
    dataType: "Deaths",
    hostilityType: "Friendlies",
  }),
  fetchAllEvents({
    code: REPORT,
    startTime,
    endTime,
    fightIDs,
    dataType: "DamageTaken",
    hostilityType: "Friendlies",
  }),
]);
console.log(`[analyze] deaths=${deaths.length} damage events=${damage.length}`);

const damageByTarget = new Map();
for (const e of damage) {
  if (typeof e.targetID !== "number") continue;
  const arr = damageByTarget.get(e.targetID) ?? [];
  arr.push(e);
  damageByTarget.set(e.targetID, arr);
}
for (const a of damageByTarget.values()) a.sort((x, y) => x.timestamp - y.timestamp);

// Enrich each death with abilities hit in window.
const deathRecs = deaths
  .filter((d) => typeof d.targetID === "number")
  .map((d) => {
    const list = damageByTarget.get(d.targetID) ?? [];
    const lo = d.timestamp - WINDOW_MS;
    const window = list.filter((e) => e.timestamp >= lo && e.timestamp <= d.timestamp);
    const abilities = new Set();
    for (const e of window) {
      const aid =
        typeof e.abilityGameID === "number"
          ? e.abilityGameID
          : typeof e.ability?.guid === "number"
            ? e.ability.guid
            : null;
      if (aid != null) abilities.add(aid);
    }
    return { timestamp: d.timestamp, targetID: d.targetID, abilities, fight: d.fight };
  });

// Collect all distinct ability names that appear in death windows.
const appearance = new Map();
for (const r of deathRecs) {
  for (const aid of r.abilities) {
    const n = abilityName.get(aid) ?? `#${aid}`;
    appearance.set(n, (appearance.get(n) ?? 0) + 1);
  }
}
const candidates = [...appearance.entries()]
  .filter(([n]) => /shock|wave|slam|quake|pound/i.test(n))
  .sort((a, b) => b[1] - a[1]);
console.log(`\n[analyze] 'shock/wave/slam/quake/pound'-like abilities in death windows:`);
for (const [n, c] of candidates) console.log(`  ${c.toString().padStart(4)}  ${n}`);

// ---- called-wipe detection ----
// Group deaths per fight, then find clusters.
const byFight = new Map();
for (const r of deathRecs) {
  const k = r.fight ?? -1;
  (byFight.get(k) ?? byFight.set(k, []).get(k)).push(r);
}
for (const arr of byFight.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

const wipeDeaths = new Set();
for (const arr of byFight.values()) {
  for (let i = 0; i < arr.length; i++) {
    // How many deaths fall within [ti, ti + WIPE_WINDOW_MS]?
    let j = i;
    while (j < arr.length && arr[j].timestamp - arr[i].timestamp <= WIPE_WINDOW_MS) j++;
    const clusterSize = j - i;
    if (clusterSize >= WIPE_MIN_DEATHS) {
      // Mark everything from (lastDeathTime - WIPE_LOOKBACK_MS) back within this fight as wipe.
      const last = arr[j - 1].timestamp;
      for (const d of arr) {
        if (d.timestamp >= last - WIPE_LOOKBACK_MS && d.timestamp <= last + WIPE_WINDOW_MS) {
          wipeDeaths.add(d);
        }
      }
    }
  }
}
console.log(
  `\n[analyze] total deaths=${deathRecs.length}; classified as called-wipe=${wipeDeaths.size}; non-wipe=${deathRecs.length - wipeDeaths.size}`,
);

function countFor(pattern) {
  const re = new RegExp(pattern, "i");
  let total = 0;
  let nonWipe = 0;
  let hitAbilityIDs = new Set();
  for (const r of deathRecs) {
    const hit = [...r.abilities].some((aid) => re.test(abilityName.get(aid) ?? ""));
    if (!hit) continue;
    for (const aid of r.abilities)
      if (re.test(abilityName.get(aid) ?? "")) hitAbilityIDs.add(aid);
    total++;
    if (!wipeDeaths.has(r)) nonWipe++;
  }
  return { total, nonWipe, abilityIDs: [...hitAbilityIDs] };
}

for (const p of ["shockwave", "shock", "pound"]) {
  const r = countFor(p);
  console.log(
    `\n[analyze] pattern /${p}/i -> deaths hit: ${r.total} (non-wipe: ${r.nonWipe}). Ability IDs matched: ${r.abilityIDs
      .map((id) => `${id}(${abilityName.get(id) ?? "?"})`)
      .join(", ") || "none"}`,
  );
}
