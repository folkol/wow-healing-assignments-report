import { getReportMeta, fetchAllEvents } from "../dist/wcl/client.js";
import { analyzePlayerDefensives } from "../dist/analysis/defensives.js";
import { analyzeDeathWindow } from "../dist/analysis/deathWindow.js";
import { wclReportUrl } from "../dist/util/links.js";

const REPORT = process.argv[2] ?? "jhTnt7Hw81fLFDyr";
const NAME = process.argv[3] ?? "Skäggbuff";
const FRESH_CD_WINDOW_MS = 30_000; // a CD pressed within 30s counts as "meaningful"
const DMG_WINDOW_MS = 10_000;

const meta = await getReportMeta(REPORT);
const actor = meta.actors.find((a) => a.name.toLowerCase() === NAME.toLowerCase());
if (!actor) {
  console.error(`No actor named ${NAME}`);
  process.exit(1);
}

const duration = meta.endTime - meta.startTime;
const allDeaths = await fetchAllEvents({
  code: REPORT,
  startTime: 0,
  endTime: duration,
  dataType: "Deaths",
  hostilityType: "Friendlies",
});
const deaths = allDeaths.filter((d) => d.targetID === actor.id);

const casts = await fetchAllEvents({
  code: REPORT,
  startTime: 0,
  endTime: duration,
  dataType: "Casts",
  hostilityType: "Friendlies",
  sourceID: actor.id,
});

const fightByID = new Map(meta.fights.map((f) => [f.id, f]));
const attemptIndexByFightID = new Map();
{
  const counter = new Map();
  for (const f of meta.fights) {
    const n = (counter.get(f.name) ?? 0) + 1;
    counter.set(f.name, n);
    attemptIndexByFightID.set(f.id, n);
  }
}

console.log(`# ${actor.name} (${actor.subType}) — deaths with NO defensive pressed in last ${FRESH_CD_WINDOW_MS / 1000}s\n`);

const candidates = [];
for (const d of deaths) {
  const fid =
    typeof d.fight === "number"
      ? d.fight
      : meta.fights.find((f) => d.timestamp >= f.startTime && d.timestamp <= f.endTime)?.id;
  const fight = fid != null ? fightByID.get(fid) : null;
  if (!fight) continue;
  const def = await analyzePlayerDefensives({
    code: REPORT,
    fight,
    actors: meta.actors,
    playerID: actor.id,
    deathTimestamp: d.timestamp,
    reportStart: meta.startTime,
    reportEnd: meta.endTime,
    preloadedCasts: casts,
  });
  const freshPressed = def.matchedSpells.some(
    (m) => m.lastCastBeforeDeathMs != null && m.lastCastBeforeDeathMs <= FRESH_CD_WINDOW_MS,
  );
  if (!freshPressed) candidates.push({ death: d, fight });
}

console.log(`Found ${candidates.length} such deaths.\n`);

// Run the damage-window analyzer once per fight so the event cap doesn't
// truncate late-in-fight damage.
const reportByFight = new Map();
for (const fid of new Set(candidates.map((c) => c.fight.id))) {
  const r = await analyzeDeathWindow({
    code: REPORT,
    fights: meta.fights,
    actors: meta.actors,
    abilities: meta.abilities,
    fightIDs: [fid],
    windowMs: DMG_WINDOW_MS,
  });
  reportByFight.set(fid, r);
}

for (const c of candidates) {
  const report = reportByFight.get(c.fight.id);
  const rec = report?.deaths.find(
    (d) => d.targetID === actor.id && d.timestamp === c.death.timestamp,
  ) ?? null;
  const attempt = attemptIndexByFightID.get(c.fight.id);
  const tIntoFightMs = c.death.timestamp - c.fight.startTime;
  const link = wclReportUrl({
    code: REPORT,
    fightID: c.fight.id,
    start: tIntoFightMs - 10_000,
    end: tIntoFightMs + 2_000,
    type: "deaths",
    targetID: actor.id,
  });
  console.log(`## ${c.fight.name} — pull #${attempt} @ ${(tIntoFightMs / 1000).toFixed(1)}s`);
  console.log(link);
  if (!rec) {
    console.log("  (no damage-window record)");
    console.log();
    continue;
  }
  if (rec.killingAbilityName) {
    console.log(`  Killing blow: ${rec.killingAbilityName}`);
  }
  // Collapse the window to per-ability totals. Keep unresolved abilities under their ID.
  const agg = new Map();
  for (const w of rec.window) {
    const key = w.abilityID ?? `n${w.timestamp}`;
    const name = w.abilityName ?? (w.abilityID != null ? `#${w.abilityID}` : "(unknown)");
    const a = agg.get(key) ?? { name, dmg: 0, hits: 0, lastT: Infinity };
    a.dmg += w.amount;
    a.hits += 1;
    a.lastT = Math.min(a.lastT, w.tBeforeDeath);
    agg.set(key, a);
  }
  const ordered = [...agg.values()].sort((a, b) => b.dmg - a.dmg).slice(0, 6);
  if (ordered.length === 0) {
    console.log(`    (no damage events recorded in last ${DMG_WINDOW_MS / 1000}s — likely a one-shot)`);
  }
  for (const a of ordered) {
    console.log(
      `    - ${a.name}: ${a.dmg.toLocaleString()} dmg over ${a.hits} hits (last hit ${(a.lastT / 1000).toFixed(1)}s before death)`,
    );
  }
  console.log();
}
