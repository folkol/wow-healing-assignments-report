import { getReportMeta } from "../dist/wcl/client.js";
import { analyzeDeathWindow } from "../dist/analysis/deathWindow.js";
import { buildDeathMapTimeline } from "../dist/analysis/timeline.js";
import { analyzePlayerDefensives } from "../dist/analysis/defensives.js";

const REPORT = process.argv[2] ?? "JHkz2pqX37WvPyM4";

console.log(`[smoke] fetching report meta for ${REPORT}...`);
const meta = await getReportMeta(REPORT);
console.log(
  `[smoke] report: ${meta.title} | zone=${meta.zone?.name ?? "?"} | fights=${meta.fights.length} | actors=${meta.actors.length}`,
);

const bossFights = meta.fights.filter((f) => f.encounterID !== 0);
console.log(`[smoke] boss fights: ${bossFights.length}`);
for (const f of bossFights.slice(0, 5)) {
  console.log(
    `  - fight ${f.id} ${f.name} kill=${f.kill} dur=${((f.endTime - f.startTime) / 1000).toFixed(1)}s`,
  );
}

const targetFight = bossFights[0];
if (!targetFight) {
  console.log("[smoke] no boss fights to analyze, exiting.");
  process.exit(0);
}

console.log(`\n[smoke] analyzing deaths for first boss fight: ${targetFight.name} (id ${targetFight.id})`);
const deaths = await analyzeDeathWindow({
  code: REPORT,
  fights: meta.fights,
  actors: meta.actors,
  abilities: meta.abilities,
  fightIDs: [targetFight.id],
  windowMs: 6000,
});
console.log(`[smoke] deaths=${deaths.totalDeaths}`);
console.log("[smoke] top abilities:");
for (const a of deaths.topAbilities.slice(0, 5)) {
  console.log(
    `  - ${a.abilityName} (#${a.abilityID}): ${a.deathsImpacted}/${deaths.totalDeaths} (${a.pctOfDeaths.toFixed(0)}%) dmg=${a.totalDamage}`,
  );
}

if (deaths.deaths.length > 0) {
  const sample = deaths.deaths[0];
  console.log(
    `\n[smoke] running defensive heuristic for ${sample.targetName} in fight ${sample.fightID}`,
  );
  const def = await analyzePlayerDefensives({
    code: REPORT,
    fight: targetFight,
    actors: meta.actors,
    playerID: sample.targetID,
    deathTimestamp: sample.timestamp,
  });
  console.log(def.summary);
}

console.log(`\n[smoke] building death map timeline for ${targetFight.name}`);
const timeline = await buildDeathMapTimeline({
  code: REPORT,
  fights: meta.fights,
  actors: meta.actors,
  abilities: meta.abilities,
  encounterID: targetFight.encounterID,
  encounterName: targetFight.name,
  includeBossCasts: false,
});
console.log(timeline.summary);
for (const d of timeline.deathMarkers.slice(0, 5)) {
  console.log(
    `  - pull #${d.attemptIndex} ${d.playerName} @ ${(d.tIntoFightMs / 1000).toFixed(1)}s x=${d.x} y=${d.y}`,
  );
}

console.log("\n[smoke] OK");
