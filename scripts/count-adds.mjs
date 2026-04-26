import { getReportMeta, fetchAllEvents } from "../dist/wcl/client.js";
import { gql } from "../dist/wcl/graphql.js";

const REPORT = process.argv[2] ?? "jhTnt7Hw81fLFDyr";
const BOSS = process.argv[3] ?? "Vorasius";

const meta = await getReportMeta(REPORT);
const kill = meta.fights.find((f) => f.name === BOSS && f.kill);
if (!kill) {
  console.error(`No kill fight for ${BOSS}`);
  process.exit(1);
}
console.log(`Kill fight id=${kill.id}, ${(kill.endTime - kill.startTime) / 1000}s`);

// Fetch enemy actors for this report (non-Player, type Enemy)
const data = await gql(
  /* GraphQL */ `
    query Enemies($code: String!) {
      reportData {
        report(code: $code) {
          masterData {
            actors(type: "NPC") {
              id
              gameID
              name
              subType
              type
            }
          }
        }
      }
    }
  `,
  { code: REPORT },
);
const npcs = data.reportData.report.masterData.actors;
const npcByID = new Map(npcs.map((a) => [a.id, a]));

const enemyDeaths = await fetchAllEvents({
  code: REPORT,
  startTime: kill.startTime,
  endTime: kill.endTime,
  fightIDs: [kill.id],
  dataType: "Deaths",
  hostilityType: "Enemies",
});
console.log(`Total enemy death events: ${enemyDeaths.length}`);

const countsByName = new Map();
const bossLike = new Set([BOSS.toLowerCase()]);
let addCount = 0;
for (const d of enemyDeaths) {
  const a = npcByID.get(d.targetID);
  const name = a?.name ?? `#${d.targetID}`;
  countsByName.set(name, (countsByName.get(name) ?? 0) + 1);
  if (!bossLike.has(name.toLowerCase())) addCount += 1;
}

console.log(`\nAdds killed (non-boss): ${addCount}\n`);
console.log(`Breakdown by name:`);
for (const [name, n] of [...countsByName.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n} × ${name}${bossLike.has(name.toLowerCase()) ? "  (boss)" : ""}`);
}
