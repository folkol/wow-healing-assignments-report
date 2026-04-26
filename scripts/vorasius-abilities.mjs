import { getReportMeta, fetchAllEvents } from "../dist/wcl/client.js";

const REPORT = "jhTnt7Hw81fLFDyr";
const meta = await getReportMeta(REPORT);
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

const agg = new Map();
for (const e of dmg) {
  const aid = e.abilityGameID ?? e.ability?.guid;
  if (aid == null) continue;
  const name = meta.abilities.find((a) => a.gameID === aid)?.name ?? `#${aid}`;
  const cur = agg.get(aid) ?? { name, total: 0, hits: 0, targets: new Set() };
  cur.total += (e.amount ?? 0) + (e.absorbed ?? 0);
  cur.hits += 1;
  if (typeof e.targetID === "number") cur.targets.add(e.targetID);
  agg.set(aid, cur);
}

const rows = [...agg.entries()].map(([aid, v]) => ({
  aid,
  name: v.name,
  total: v.total,
  hits: v.hits,
  targets: v.targets.size,
}));
rows.sort((a, b) => b.total - a.total);

console.log("Top damage-taken abilities on Vorasius pulls (all fights):\n");
for (const r of rows.slice(0, 40)) {
  console.log(
    `  ${r.aid.toString().padStart(8)}  ${r.name.padEnd(30)}  total ${r.total.toLocaleString().padStart(12)}  hits ${String(r.hits).padStart(5)}  targets ${r.targets}`,
  );
}
