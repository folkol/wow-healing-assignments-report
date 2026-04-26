import { getReportMeta, fetchAllEvents } from "../dist/wcl/client.js";
import { analyzePlayerDefensives } from "../dist/analysis/defensives.js";
import { wclReportUrl } from "../dist/util/links.js";

// Prefetch casts once per player across entire report to avoid N trips.
// WCL events endpoint expects timestamps relative to report start, so we
// span 0..duration even though meta.startTime/endTime are absolute epoch millis.
async function loadPlayerCasts(code, reportStart, reportEnd, playerID) {
  return fetchAllEvents({
    code,
    startTime: 0,
    endTime: reportEnd - reportStart,
    dataType: "Casts",
    hostilityType: "Friendlies",
    sourceID: playerID,
  });
}

const REPORT = "jhTnt7Hw81fLFDyr";
const WIPE_MIN = 5;
const WIPE_WIN_MS = 10_000;
const WIPE_LOOK_MS = 15_000;

const meta = await getReportMeta(REPORT);
const vFights = meta.fights.filter((f) => f.name === "Vorasius");
const fightByID = new Map(vFights.map((f) => [f.id, f]));
const fightIDs = vFights.map((f) => f.id);
const attemptIndex = new Map();
{
  let i = 0;
  for (const f of meta.fights) if (f.name === "Vorasius") attemptIndex.set(f.id, ++i);
}

const deaths = await fetchAllEvents({
  code: REPORT,
  startTime: Math.min(...vFights.map((f) => f.startTime)),
  endTime: Math.max(...vFights.map((f) => f.endTime)),
  fightIDs,
  dataType: "Deaths",
  hostilityType: "Friendlies",
});

// Classify wipe deaths.
const byFight = new Map();
for (const d of deaths) {
  const fid =
    typeof d.fight === "number"
      ? d.fight
      : vFights.find((f) => d.timestamp >= f.startTime && d.timestamp <= f.endTime)?.id;
  if (fid == null) continue;
  (byFight.get(fid) ?? byFight.set(fid, []).get(fid)).push({ ...d, _fightID: fid });
}
const wipeSet = new Set();
for (const arr of byFight.values()) {
  arr.sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 0; i < arr.length; i++) {
    let j = i;
    while (j < arr.length && arr[j].timestamp - arr[i].timestamp <= WIPE_WIN_MS) j++;
    if (j - i >= WIPE_MIN) {
      const last = arr[j - 1].timestamp;
      for (const d of arr)
        if (d.timestamp >= last - WIPE_LOOK_MS && d.timestamp <= last + WIPE_WIN_MS) wipeSet.add(d);
    }
  }
}
const all = [...byFight.values()].flat();
const nonWipe = all.filter((d) => !wipeSet.has(d));

// Rank by non-wipe death count.
const perPlayer = new Map();
for (const d of nonWipe) {
  const tid = d.targetID;
  const arr = perPlayer.get(tid) ?? [];
  arr.push(d);
  perPlayer.set(tid, arr);
}
const ranked = [...perPlayer.entries()]
  .map(([tid, arr]) => ({
    targetID: tid,
    name: meta.actors.find((a) => a.id === tid)?.name ?? `actor#${tid}`,
    className: meta.actors.find((a) => a.id === tid)?.subType ?? null,
    deaths: arr.sort((a, b) => a.timestamp - b.timestamp),
  }))
  .sort((a, b) => b.deaths.length - a.deaths.length)
  .slice(0, 3);

console.log(
  `# Early-death cooldown audit (Vorasius — report ${REPORT})\n\nNon-wipe deaths are deaths NOT part of a cluster of ${WIPE_MIN}+ deaths within ${WIPE_WIN_MS / 1000}s. Defensive availability is a heuristic (last cast + nominal CD, no charges/haste).\n`,
);
console.log(`Report link: https://www.warcraftlogs.com/reports/${REPORT}\n`);

for (const p of ranked) {
  console.log(`## ${p.name} (${p.className ?? "?"}) — ${p.deaths.length} non-wipe death(s)\n`);
  const playerCasts = await loadPlayerCasts(
    REPORT,
    meta.startTime,
    meta.endTime,
    p.targetID,
  );
  for (const d of p.deaths) {
    const fight = fightByID.get(d._fightID);
    if (!fight) continue;
    const def = await analyzePlayerDefensives({
      code: REPORT,
      fight,
      actors: meta.actors,
      playerID: p.targetID,
      deathTimestamp: d.timestamp,
      reportStart: meta.startTime,
      reportEnd: meta.endTime,
      preloadedCasts: playerCasts,
    });
    const tIntoFightMs = d.timestamp - fight.startTime;
    const link = wclReportUrl({
      code: REPORT,
      fightID: fight.id,
      start: tIntoFightMs - 10_000,
      end: tIntoFightMs + 2_000,
      type: "deaths",
      targetID: p.targetID,
    });
    console.log(
      `- Pull #${attemptIndex.get(fight.id)} @ ${(tIntoFightMs / 1000).toFixed(1)}s into fight | ${link}`,
    );
    const ordered = [...def.matchedSpells].sort((a, b) => {
      const A = a.lastCastBeforeDeathMs;
      const B = b.lastCastBeforeDeathMs;
      if (A == null && B == null) return a.abilityName.localeCompare(b.abilityName);
      if (A == null) return 1;
      if (B == null) return -1;
      return A - B;
    });
    if (ordered.length === 0) {
      console.log("    - (no tracked defensives observed in kit for this player)");
    }
    for (const m of ordered) {
      const s =
        m.lastCastBeforeDeathMs == null
          ? "not pressed this fight"
          : `pressed ${(m.lastCastBeforeDeathMs / 1000).toFixed(1)}s before death`;
      console.log(`    - ${m.abilityName} (CD ${m.cooldownSec}s): ${s}`);
    }
  }
  console.log();
}
