import type { Ability, Actor, Fight, WclEvent } from "../wcl/client.js";
import { fetchAllEvents } from "../wcl/client.js";

export interface DeathRecord {
  fightID: number;
  fightName: string;
  attemptIndex: number;
  targetID: number;
  targetName: string | null;
  targetClass: string | null;
  timestamp: number;
  killingAbilityGameID: number | null;
  killingAbilityName: string | null;
  window: Array<{
    timestamp: number;
    tBeforeDeath: number;
    abilityID: number | null;
    abilityName: string | null;
    amount: number;
    overkill: number;
    type: string | null;
    sourceID: number | null;
  }>;
}

export interface DeathWindowReport {
  windowMs: number;
  totalDeaths: number;
  deathsByPlayer: Array<{ name: string | null; count: number }>;
  topAbilities: Array<{
    abilityID: number;
    abilityName: string;
    deathsImpacted: number;
    pctOfDeaths: number;
    totalDamage: number;
    hitCount: number;
  }>;
  deaths: DeathRecord[];
  summary: string;
}

function actorName(actors: Actor[], id: number | undefined): string | null {
  if (id == null) return null;
  return actors.find((a) => a.id === id)?.name ?? null;
}

function actorClass(actors: Actor[], id: number | undefined): string | null {
  if (id == null) return null;
  const a = actors.find((a) => a.id === id);
  return a?.subType ?? null;
}

export async function analyzeDeathWindow(args: {
  code: string;
  fights: Fight[];
  actors: Actor[];
  abilities?: Ability[];
  fightIDs?: number[];
  windowMs?: number;
}): Promise<DeathWindowReport> {
  const abilityNameByID = new Map<number, string>();
  for (const a of args.abilities ?? []) {
    if (a.name) abilityNameByID.set(a.gameID, a.name);
  }
  const resolveName = (id: number | null, fallback: string | null): string | null => {
    if (fallback) return fallback;
    if (id == null) return null;
    return abilityNameByID.get(id) ?? null;
  };
  const windowMs = args.windowMs ?? 6_000;
  const selected = args.fightIDs
    ? args.fights.filter((f) => args.fightIDs!.includes(f.id))
    : args.fights;
  if (selected.length === 0) {
    return {
      windowMs,
      totalDeaths: 0,
      deathsByPlayer: [],
      topAbilities: [],
      deaths: [],
      summary: "No fights selected.",
    };
  }

  const startTime = Math.min(...selected.map((f) => f.startTime));
  const endTime = Math.max(...selected.map((f) => f.endTime));
  const fightIDs = selected.map((f) => f.id);

  const [deathEvents, damageEvents] = await Promise.all([
    fetchAllEvents({
      code: args.code,
      startTime,
      endTime,
      fightIDs,
      dataType: "Deaths",
      hostilityType: "Friendlies",
    }),
    fetchAllEvents({
      code: args.code,
      startTime,
      endTime,
      fightIDs,
      dataType: "DamageTaken",
      hostilityType: "Friendlies",
    }),
  ]);

  // Index damage by (targetID, timestamp sorted)
  const damageByTarget = new Map<number, WclEvent[]>();
  for (const e of damageEvents) {
    const tid = e.targetID;
    if (typeof tid !== "number") continue;
    let arr = damageByTarget.get(tid);
    if (!arr) {
      arr = [];
      damageByTarget.set(tid, arr);
    }
    arr.push(e);
  }
  for (const arr of damageByTarget.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

  // Attempt index per encounter for human-friendly "pull #N" labels
  const encounterCounts = new Map<number, number>();
  const attemptIndexByFightID = new Map<number, number>();
  for (const f of args.fights) {
    const next = (encounterCounts.get(f.encounterID) ?? 0) + 1;
    encounterCounts.set(f.encounterID, next);
    attemptIndexByFightID.set(f.id, next);
  }

  const deaths: DeathRecord[] = [];
  const abilityAgg = new Map<
    number,
    { name: string; deathsImpacted: Set<string>; totalDamage: number; hitCount: number }
  >();

  for (const de of deathEvents) {
    const tid = typeof de.targetID === "number" ? de.targetID : null;
    if (tid == null) continue;
    const fight = selected.find((f) => f.id === (de.fight as number | undefined)) ??
      selected.find((f) => de.timestamp >= f.startTime && de.timestamp <= f.endTime);
    if (!fight) continue;

    const targetDamage = damageByTarget.get(tid) ?? [];
    const lo = de.timestamp - windowMs;
    const windowEvents = targetDamage.filter((d) => d.timestamp >= lo && d.timestamp <= de.timestamp);

    const deathKey = `${fight.id}:${tid}:${de.timestamp}`;
    const record: DeathRecord = {
      fightID: fight.id,
      fightName: fight.name,
      attemptIndex: attemptIndexByFightID.get(fight.id) ?? 0,
      targetID: tid,
      targetName: actorName(args.actors, tid),
      targetClass: actorClass(args.actors, tid),
      timestamp: de.timestamp,
      killingAbilityGameID:
        typeof de.killingAbilityGameID === "number" ? de.killingAbilityGameID : null,
      killingAbilityName: resolveName(
        typeof de.killingAbilityGameID === "number" ? de.killingAbilityGameID : null,
        typeof de.ability === "object" && de.ability && "name" in de.ability
          ? String((de.ability as { name?: string }).name ?? "") || null
          : null,
      ),
      window: windowEvents.map((d) => {
        const abilityID =
          typeof d.abilityGameID === "number"
            ? d.abilityGameID
            : typeof (d.ability as { guid?: number } | undefined)?.guid === "number"
              ? (d.ability as { guid: number }).guid
              : null;
        const rawName =
          typeof (d.ability as { name?: string } | undefined)?.name === "string"
            ? (d.ability as { name: string }).name
            : null;
        return {
          timestamp: d.timestamp,
          tBeforeDeath: de.timestamp - d.timestamp,
          abilityID,
          abilityName: resolveName(abilityID, rawName),
          amount: typeof d.amount === "number" ? d.amount : 0,
          overkill: typeof d.overkill === "number" ? d.overkill : 0,
          type: typeof d.type === "string" ? d.type : null,
          sourceID: typeof d.sourceID === "number" ? d.sourceID : null,
        };
      }),
    };
    deaths.push(record);

    const seenAbilities = new Set<number>();
    for (const w of record.window) {
      if (w.abilityID == null) continue;
      const existing = abilityAgg.get(w.abilityID);
      const name = w.abilityName ?? existing?.name ?? `#${w.abilityID}`;
      const agg =
        existing ?? {
          name,
          deathsImpacted: new Set<string>(),
          totalDamage: 0,
          hitCount: 0,
        };
      if (!existing) abilityAgg.set(w.abilityID, agg);
      agg.name = name;
      agg.totalDamage += w.amount;
      agg.hitCount += 1;
      if (!seenAbilities.has(w.abilityID)) {
        agg.deathsImpacted.add(deathKey);
        seenAbilities.add(w.abilityID);
      }
    }
  }

  const totalDeaths = deaths.length;
  const byPlayer = new Map<string | null, number>();
  for (const d of deaths) byPlayer.set(d.targetName, (byPlayer.get(d.targetName) ?? 0) + 1);
  const deathsByPlayer = [...byPlayer.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const topAbilities = [...abilityAgg.entries()]
    .map(([id, v]) => ({
      abilityID: id,
      abilityName: v.name,
      deathsImpacted: v.deathsImpacted.size,
      pctOfDeaths: totalDeaths > 0 ? (v.deathsImpacted.size / totalDeaths) * 100 : 0,
      totalDamage: v.totalDamage,
      hitCount: v.hitCount,
    }))
    .sort((a, b) => b.deathsImpacted - a.deathsImpacted || b.totalDamage - a.totalDamage)
    .slice(0, 15);

  let summary: string;
  if (totalDeaths === 0) {
    summary = "No friendly deaths in the selected fights.";
  } else {
    const bullets = topAbilities
      .slice(0, 5)
      .map(
        (a) =>
          `- ${a.deathsImpacted}/${totalDeaths} (${a.pctOfDeaths.toFixed(
            0,
          )}%) deaths took ${a.abilityName} in the last ${Math.round(windowMs / 1000)}s (total ${
            a.totalDamage.toLocaleString()
          } dmg across ${a.hitCount} hits)`,
      )
      .join("\n");
    summary = `Analyzed ${totalDeaths} deaths across ${selected.length} fight(s), window ${Math.round(
      windowMs / 1000,
    )}s before death.\n${bullets}`;
  }

  return {
    windowMs,
    totalDeaths,
    deathsByPlayer,
    topAbilities,
    deaths,
    summary,
  };
}
