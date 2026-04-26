import type { Ability, Actor, Fight, WclEvent } from "../wcl/client.js";
import { fetchAllEvents } from "../wcl/client.js";

export interface CounterfactualArgs {
  code: string;
  fights: Fight[];
  actors: Actor[];
  abilities: Ability[];
  fightIDs: number[];
  abilityPattern: string;
  windowMs: number;
  wipeMinDeaths: number;
  wipeWindowMs: number;
  wipeLookbackMs: number;
}

export interface CounterfactualReport {
  abilityPattern: string;
  windowMs: number;
  wipeRule: {
    minDeaths: number;
    windowMs: number;
    lookbackMs: number;
  };
  fightCount: number;
  totalDeaths: number;
  wipeDeaths: number;
  nonWipeDeaths: number;
  matchedAbilities: Array<{
    abilityID: number;
    abilityName: string;
    distinctDeathsHit: number;
  }>;
  deathsHitTotal: number;
  deathsHitNonWipe: number;
  perPlayer: Array<{
    name: string | null;
    totalDeaths: number;
    deathsHit: number;
    nonWipeDeathsHit: number;
  }>;
  sampleDeaths: Array<{
    fightID: number;
    attemptIndex: number;
    playerName: string | null;
    timestamp: number;
    tIntoFightMs: number;
    hitAbilities: Array<{ abilityID: number; abilityName: string; tBeforeDeathMs: number; amount: number }>;
    isWipeDeath: boolean;
  }>;
  summary: string;
}

function buildRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow the user to pass either a plain string or a rough phrase; match case-insensitive.
  return new RegExp(escaped, "i");
}

export async function analyzeCounterfactualAvoidance(
  args: CounterfactualArgs,
): Promise<CounterfactualReport> {
  const selected = args.fights.filter((f) => args.fightIDs.includes(f.id));
  if (selected.length === 0) {
    return {
      abilityPattern: args.abilityPattern,
      windowMs: args.windowMs,
      wipeRule: {
        minDeaths: args.wipeMinDeaths,
        windowMs: args.wipeWindowMs,
        lookbackMs: args.wipeLookbackMs,
      },
      fightCount: 0,
      totalDeaths: 0,
      wipeDeaths: 0,
      nonWipeDeaths: 0,
      matchedAbilities: [],
      deathsHitTotal: 0,
      deathsHitNonWipe: 0,
      perPlayer: [],
      sampleDeaths: [],
      summary: "No fights selected.",
    };
  }

  const startTime = Math.min(...selected.map((f) => f.startTime));
  const endTime = Math.max(...selected.map((f) => f.endTime));
  const fightIDs = selected.map((f) => f.id);

  const abilityName = new Map<number, string>();
  for (const a of args.abilities) if (a.name) abilityName.set(a.gameID, a.name);

  const encounterAttemptIndex = new Map<number, number>();
  {
    const counts = new Map<number, number>();
    for (const f of args.fights) {
      const next = (counts.get(f.encounterID) ?? 0) + 1;
      counts.set(f.encounterID, next);
      encounterAttemptIndex.set(f.id, next);
    }
  }
  const actorName = (id: number | undefined) =>
    id == null ? null : args.actors.find((a) => a.id === id)?.name ?? null;

  const [deaths, damage] = await Promise.all([
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

  const damageByTarget = new Map<number, WclEvent[]>();
  for (const e of damage) {
    if (typeof e.targetID !== "number") continue;
    let arr = damageByTarget.get(e.targetID);
    if (!arr) {
      arr = [];
      damageByTarget.set(e.targetID, arr);
    }
    arr.push(e);
  }
  for (const arr of damageByTarget.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

  interface EnrichedDeath {
    ev: WclEvent;
    fightID: number;
    abilitiesInWindow: Map<number, { name: string; tBeforeDeathMs: number; amount: number }>;
  }

  const enriched: EnrichedDeath[] = [];
  for (const d of deaths) {
    if (typeof d.targetID !== "number") continue;
    const tid = d.targetID;
    const fightID =
      typeof d.fight === "number"
        ? d.fight
        : selected.find((f) => d.timestamp >= f.startTime && d.timestamp <= f.endTime)?.id;
    if (fightID == null) continue;
    const arr = damageByTarget.get(tid) ?? [];
    const lo = d.timestamp - args.windowMs;
    const abilitiesInWindow = new Map<
      number,
      { name: string; tBeforeDeathMs: number; amount: number }
    >();
    for (const e of arr) {
      if (e.timestamp < lo) continue;
      if (e.timestamp > d.timestamp) break;
      const aid =
        typeof e.abilityGameID === "number"
          ? e.abilityGameID
          : typeof (e.ability as { guid?: number } | undefined)?.guid === "number"
            ? (e.ability as { guid: number }).guid
            : null;
      if (aid == null) continue;
      const name = abilityName.get(aid) ?? `#${aid}`;
      const existing = abilitiesInWindow.get(aid);
      const amount = typeof e.amount === "number" ? e.amount : 0;
      if (!existing) {
        abilitiesInWindow.set(aid, {
          name,
          tBeforeDeathMs: d.timestamp - e.timestamp,
          amount,
        });
      } else {
        existing.amount += amount;
        existing.tBeforeDeathMs = Math.min(existing.tBeforeDeathMs, d.timestamp - e.timestamp);
      }
    }
    enriched.push({ ev: d, fightID, abilitiesInWindow });
  }

  // Classify called-wipe deaths.
  const perFight = new Map<number, EnrichedDeath[]>();
  for (const e of enriched) {
    let arr = perFight.get(e.fightID);
    if (!arr) {
      arr = [];
      perFight.set(e.fightID, arr);
    }
    arr.push(e);
  }
  const wipeDeaths = new Set<EnrichedDeath>();
  for (const arr of perFight.values()) {
    arr.sort((a, b) => a.ev.timestamp - b.ev.timestamp);
    for (let i = 0; i < arr.length; i++) {
      let j = i;
      while (
        j < arr.length &&
        arr[j].ev.timestamp - arr[i].ev.timestamp <= args.wipeWindowMs
      ) {
        j++;
      }
      const clusterSize = j - i;
      if (clusterSize >= args.wipeMinDeaths) {
        const last = arr[j - 1].ev.timestamp;
        for (const d of arr) {
          const t = d.ev.timestamp;
          if (t >= last - args.wipeLookbackMs && t <= last + args.wipeWindowMs) {
            wipeDeaths.add(d);
          }
        }
      }
    }
  }

  const re = buildRegex(args.abilityPattern);
  const matchedAbilityIDs = new Map<number, { name: string; distinctDeathsHit: Set<EnrichedDeath> }>();
  let deathsHitTotal = 0;
  let deathsHitNonWipe = 0;
  const perPlayerAgg = new Map<
    number,
    { name: string | null; total: number; hit: number; nonWipeHit: number }
  >();

  for (const d of enriched) {
    const tid = d.ev.targetID as number;
    const player = perPlayerAgg.get(tid) ?? {
      name: actorName(tid),
      total: 0,
      hit: 0,
      nonWipeHit: 0,
    };
    perPlayerAgg.set(tid, player);
    player.total += 1;

    let matched = false;
    for (const [aid, v] of d.abilitiesInWindow) {
      if (re.test(v.name)) {
        matched = true;
        let entry = matchedAbilityIDs.get(aid);
        if (!entry) {
          entry = { name: v.name, distinctDeathsHit: new Set() };
          matchedAbilityIDs.set(aid, entry);
        }
        entry.distinctDeathsHit.add(d);
      }
    }
    if (matched) {
      deathsHitTotal += 1;
      player.hit += 1;
      if (!wipeDeaths.has(d)) {
        deathsHitNonWipe += 1;
        player.nonWipeHit += 1;
      }
    }
  }

  const totalDeaths = enriched.length;
  const wipeCount = wipeDeaths.size;

  const matchedAbilities = [...matchedAbilityIDs.entries()]
    .map(([id, v]) => ({
      abilityID: id,
      abilityName: v.name,
      distinctDeathsHit: v.distinctDeathsHit.size,
    }))
    .sort((a, b) => b.distinctDeathsHit - a.distinctDeathsHit);

  const perPlayer = [...perPlayerAgg.values()]
    .filter((p) => p.hit > 0)
    .sort((a, b) => b.nonWipeHit - a.nonWipeHit || b.hit - a.hit)
    .map((p) => ({
      name: p.name,
      totalDeaths: p.total,
      deathsHit: p.hit,
      nonWipeDeathsHit: p.nonWipeHit,
    }));

  const sampleDeaths = enriched
    .filter((d) => [...d.abilitiesInWindow.values()].some((v) => re.test(v.name)))
    .slice(0, 10)
    .map((d) => {
      const fight = selected.find((f) => f.id === d.fightID)!;
      return {
        fightID: d.fightID,
        attemptIndex: encounterAttemptIndex.get(d.fightID) ?? 0,
        playerName: actorName(d.ev.targetID as number),
        timestamp: d.ev.timestamp,
        tIntoFightMs: d.ev.timestamp - fight.startTime,
        hitAbilities: [...d.abilitiesInWindow.entries()]
          .filter(([, v]) => re.test(v.name))
          .map(([aid, v]) => ({
            abilityID: aid,
            abilityName: v.name,
            tBeforeDeathMs: v.tBeforeDeathMs,
            amount: v.amount,
          })),
        isWipeDeath: wipeDeaths.has(d),
      };
    });

  const nonWipe = totalDeaths - wipeCount;
  const pctHit = totalDeaths > 0 ? ((deathsHitTotal / totalDeaths) * 100).toFixed(1) : "0.0";
  const pctNonWipe = nonWipe > 0 ? ((deathsHitNonWipe / nonWipe) * 100).toFixed(1) : "0.0";
  const caveat =
    " Upper bound: 'hit by' does not mean 'killed by'; the ability simply ticked in the window.";
  const summary = matchedAbilities.length
    ? `Pattern "${args.abilityPattern}" matched ${matchedAbilities.length} ability(ies): ${matchedAbilities
        .slice(0, 5)
        .map((a) => a.abilityName)
        .join(", ")}. ${deathsHitTotal}/${totalDeaths} deaths (${pctHit}%) had it in the last ${Math.round(
        args.windowMs / 1000,
      )}s; excluding ${wipeCount} called-wipe deaths, ${deathsHitNonWipe}/${nonWipe} non-wipe deaths (${pctNonWipe}%) would potentially have been avoided.${caveat}`
    : `No abilities matched the pattern "${args.abilityPattern}" in any death window across ${totalDeaths} death(s).`;

  return {
    abilityPattern: args.abilityPattern,
    windowMs: args.windowMs,
    wipeRule: {
      minDeaths: args.wipeMinDeaths,
      windowMs: args.wipeWindowMs,
      lookbackMs: args.wipeLookbackMs,
    },
    fightCount: selected.length,
    totalDeaths,
    wipeDeaths: wipeCount,
    nonWipeDeaths: nonWipe,
    matchedAbilities,
    deathsHitTotal,
    deathsHitNonWipe,
    perPlayer,
    sampleDeaths,
    summary,
  };
}
