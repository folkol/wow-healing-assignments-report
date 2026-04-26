import { getReportMeta, fetchAllEvents } from "../dist/wcl/client.js";
import { analyzePlayerDefensives } from "../dist/analysis/defensives.js";
import { wclReportUrl } from "../dist/util/links.js";

const REPORT = process.argv[2] ?? "jhTnt7Hw81fLFDyr";
const NAME = process.argv[3] ?? "Skäggbuff";

const meta = await getReportMeta(REPORT);
const actor = meta.actors.find((a) => a.name.toLowerCase() === NAME.toLowerCase());
if (!actor) {
  console.error(`No actor named ${NAME} found in report ${REPORT}.`);
  const candidates = meta.actors
    .map((a) => a.name)
    .filter((n) => n.toLowerCase().includes(NAME.toLowerCase().slice(0, 4)));
  if (candidates.length) console.error("Close matches:", candidates.join(", "));
  process.exit(1);
}

console.log(`# ${actor.name} (${actor.subType}) deaths in report ${REPORT}\n`);
console.log(`Report link: https://www.warcraftlogs.com/reports/${REPORT}\n`);

const duration = meta.endTime - meta.startTime;
const allDeaths = await fetchAllEvents({
  code: REPORT,
  startTime: 0,
  endTime: duration,
  dataType: "Deaths",
  hostilityType: "Friendlies",
});
// WCL's events endpoint does not apply the targetID filter to Deaths, so filter here.
const deaths = allDeaths.filter((d) => d.targetID === actor.id);

if (deaths.length === 0) {
  console.log("(no deaths recorded for this player)");
  process.exit(0);
}

const playerCasts = await fetchAllEvents({
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

console.log(`Total deaths: ${deaths.length}\n`);

for (const d of deaths) {
  const fid =
    typeof d.fight === "number"
      ? d.fight
      : meta.fights.find((f) => d.timestamp >= f.startTime && d.timestamp <= f.endTime)?.id;
  const fight = fid != null ? fightByID.get(fid) : null;
  if (!fight) {
    console.log(`- (unattached death @ t=${d.timestamp})`);
    continue;
  }
  const def = await analyzePlayerDefensives({
    code: REPORT,
    fight,
    actors: meta.actors,
    playerID: actor.id,
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
    targetID: actor.id,
  });
  const attempt = attemptIndexByFightID.get(fight.id);
  console.log(
    `## ${fight.name} — pull #${attempt}${fight.kill ? " (kill)" : ""} @ ${(tIntoFightMs / 1000).toFixed(1)}s`,
  );
  console.log(`${link}`);
  const ordered = [...def.matchedSpells].sort((a, b) => {
    const A = a.lastCastBeforeDeathMs;
    const B = b.lastCastBeforeDeathMs;
    if (A == null && B == null) return a.abilityName.localeCompare(b.abilityName);
    if (A == null) return 1;
    if (B == null) return -1;
    return A - B;
  });
  if (ordered.length === 0) {
    console.log("  (no tracked defensives observed in kit for this player)");
  }
  for (const m of ordered) {
    const s =
      m.lastCastBeforeDeathMs == null
        ? "not pressed this fight"
        : `pressed ${(m.lastCastBeforeDeathMs / 1000).toFixed(1)}s before death`;
    const cd = m.cooldownSec > 0 ? ` (CD ${m.cooldownSec}s)` : "";
    console.log(`  - ${m.abilityName}${cd}: ${s}`);
  }
  if (def.activeBuffsAtDeath.length) {
    const notable = def.activeBuffsAtDeath
      .map((b) => b.abilityName ?? `#${b.abilityID}`)
      .filter(Boolean);
    if (notable.length) console.log(`  [active auras at death: ${notable.join(", ")}]`);
  }
  console.log();
}
