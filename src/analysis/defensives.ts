import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { Actor, Fight, WclEvent } from "../wcl/client.js";
import { fetchAllEvents } from "../wcl/client.js";

interface SpellEntry {
  id: number;
  name: string;
  cooldownSec: number;
  class: string;
}

function loadSpells(): SpellEntry[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/analysis/defensives.js  -> ../../src/data/defensive-spells.json is gone at runtime,
  // so we ship the JSON next to the compiled output as ../data/defensive-spells.json.
  const candidates = [
    resolve(here, "..", "data", "defensive-spells.json"),
    resolve(here, "..", "..", "src", "data", "defensive-spells.json"),
  ];
  for (const p of candidates) {
    try {
      const text = readFileSync(p, "utf8");
      const parsed = JSON.parse(text) as { spells: SpellEntry[] };
      return parsed.spells;
    } catch {
      // try next
    }
  }
  return [];
}

const SPELLS: SpellEntry[] = loadSpells();
const SPELL_BY_ID = new Map<number, SpellEntry>(SPELLS.map((s) => [s.id, s]));

export interface DefensiveStatus {
  abilityID: number;
  abilityName: string;
  cooldownSec: number;
  classKnown: string;
  lastCastTimestamp: number | null;
  lastCastBeforeDeathMs: number | null;
  availableAtDeath: boolean;
  availableIn: number | null;
}

export interface DefensiveReport {
  reportCode: string;
  fightID: number;
  fightName: string;
  playerID: number;
  playerName: string;
  playerClass: string | null;
  deathTimestamp: number;
  matchedSpells: DefensiveStatus[];
  unmatchedCasts: Array<{
    abilityID: number | null;
    abilityName: string | null;
    timestamp: number;
    tBeforeDeath: number;
  }>;
  activeBuffsAtDeath: Array<{
    abilityID: number | null;
    abilityName: string | null;
  }>;
  summary: string;
}

export async function analyzePlayerDefensives(args: {
  code: string;
  fight: Fight;
  actors: Actor[];
  playerID: number;
  deathTimestamp: number;
  reportStart: number;
  reportEnd: number;
  requireEvidence?: boolean;
  /**
   * Optional: casts for this player across the entire report. If provided, the
   * function will skip its own casts fetch. Useful when analyzing many deaths
   * for the same player to avoid N round-trips.
   */
  preloadedCasts?: WclEvent[];
}): Promise<DefensiveReport> {
  const { code, fight, playerID, deathTimestamp, reportStart, reportEnd } = args;
  const requireEvidence = args.requireEvidence ?? true;
  const actor = args.actors.find((a) => a.id === playerID) ?? null;
  const playerClass = actor?.subType ?? null;
  const playerName = actor?.name ?? `actor#${playerID}`;

  // Pull all casts by this player across the ENTIRE report (one pass).
  // Used for two purposes:
  //  - kit evidence: did we ever see them press this spell at all?
  //  - CD tracking: last cast in THIS fight, before death.
  const [allCasts, buffs] = await Promise.all([
    args.preloadedCasts
      ? Promise.resolve(args.preloadedCasts)
      : fetchAllEvents({
          code,
          // WCL events API expects timestamps relative to report start. Fight
          // times are already relative, so for "whole report" we use 0..duration.
          startTime: 0,
          endTime: reportEnd - reportStart,
          dataType: "Casts",
          hostilityType: "Friendlies",
          sourceID: playerID,
        }),
    fetchAllEvents({
      code,
      startTime: fight.startTime,
      endTime: Math.min(deathTimestamp + 1, fight.endTime),
      fightIDs: [fight.id],
      dataType: "Buffs",
      hostilityType: "Friendlies",
      targetID: playerID,
    }),
  ]);

  const castsInReport = new Map<number, WclEvent[]>();
  const unmatched: DefensiveReport["unmatchedCasts"] = [];
  for (const c of allCasts) {
    const aid =
      typeof c.abilityGameID === "number"
        ? c.abilityGameID
        : typeof (c.ability as { guid?: number } | undefined)?.guid === "number"
          ? (c.ability as { guid: number }).guid
          : null;
    if (aid == null) continue;
    let arr = castsInReport.get(aid);
    if (!arr) {
      arr = [];
      castsInReport.set(aid, arr);
    }
    arr.push(c);
    if (
      !SPELL_BY_ID.has(aid) &&
      c.timestamp >= fight.startTime &&
      c.timestamp <= deathTimestamp
    ) {
      unmatched.push({
        abilityID: aid,
        abilityName:
          typeof (c.ability as { name?: string } | undefined)?.name === "string"
            ? (c.ability as { name: string }).name
            : null,
        timestamp: c.timestamp,
        tBeforeDeath: deathTimestamp - c.timestamp,
      });
    }
  }
  // For CD calc: last cast of this ability in THIS fight, before death.
  const lastCastInFightByAbility = new Map<number, WclEvent>();
  for (const [aid, arr] of castsInReport) {
    for (const c of arr) {
      if (c.timestamp < fight.startTime) continue;
      if (c.timestamp > deathTimestamp) break;
      const prev = lastCastInFightByAbility.get(aid);
      if (!prev || prev.timestamp < c.timestamp) lastCastInFightByAbility.set(aid, c);
    }
  }

  // Active buffs at death: track applybuff/removebuff pairs for the player.
  const activeAuras = new Map<number, { name: string | null }>();
  for (const b of buffs) {
    if (b.timestamp > deathTimestamp) break;
    const aid =
      typeof b.abilityGameID === "number"
        ? b.abilityGameID
        : typeof (b.ability as { guid?: number } | undefined)?.guid === "number"
          ? (b.ability as { guid: number }).guid
          : null;
    if (aid == null) continue;
    const name =
      typeof (b.ability as { name?: string } | undefined)?.name === "string"
        ? (b.ability as { name: string }).name
        : null;
    const t = typeof b.type === "string" ? b.type : "";
    if (t === "applybuff" || t === "applybuffstack" || t === "refreshbuff") {
      activeAuras.set(aid, { name });
    } else if (t === "removebuff") {
      activeAuras.delete(aid);
    }
  }

  const matched: DefensiveStatus[] = [];
  for (const spell of SPELLS) {
    if (spell.class !== playerClass && playerClass) continue;
    const castsForSpell = castsInReport.get(spell.id) ?? [];
    // Evidence gate: require at least one cast of this spell in the report, otherwise we
    // can't tell whether the player has it talented or is even in a spec that can use it.
    if (requireEvidence && castsForSpell.length === 0) continue;
    const lastCast = lastCastInFightByAbility.get(spell.id);
    const lastMs = lastCast?.timestamp ?? null;
    const elapsedMs = lastMs != null ? deathTimestamp - lastMs : null;
    const cdMs = spell.cooldownSec * 1000;
    const available = lastMs == null || (elapsedMs != null && elapsedMs >= cdMs);
    matched.push({
      abilityID: spell.id,
      abilityName: spell.name,
      cooldownSec: spell.cooldownSec,
      classKnown: spell.class,
      lastCastTimestamp: lastMs,
      lastCastBeforeDeathMs: elapsedMs,
      availableAtDeath: available,
      availableIn: available ? 0 : cdMs - (elapsedMs ?? 0),
    });
  }

  // If class unknown, also consider any defensive the player was actually observed casting.
  if (!playerClass) {
    for (const [aid, arr] of castsInReport) {
      const spell = SPELL_BY_ID.get(aid);
      if (!spell) continue;
      if (matched.some((m) => m.abilityID === aid)) continue;
      const lastInFight = lastCastInFightByAbility.get(aid);
      const elapsedMs = lastInFight ? deathTimestamp - lastInFight.timestamp : null;
      const cdMs = spell.cooldownSec * 1000;
      const available = elapsedMs == null || elapsedMs >= cdMs;
      matched.push({
        abilityID: aid,
        abilityName: spell.name,
        cooldownSec: spell.cooldownSec,
        classKnown: spell.class,
        lastCastTimestamp: lastInFight?.timestamp ?? null,
        lastCastBeforeDeathMs: elapsedMs,
        availableAtDeath: available,
        availableIn: available ? 0 : Math.max(0, cdMs - (elapsedMs ?? 0)),
      });
      void arr;
    }
  }

  const activeBuffsAtDeath = [...activeAuras.entries()].map(([aid, v]) => ({
    abilityID: aid,
    abilityName: v.name,
  }));

  // Order by: pressed most recently first, then "not pressed this fight" at the end.
  const ordered = [...matched].sort((a, b) => {
    const aMs = a.lastCastBeforeDeathMs;
    const bMs = b.lastCastBeforeDeathMs;
    if (aMs == null && bMs == null) return a.abilityName.localeCompare(b.abilityName);
    if (aMs == null) return 1;
    if (bMs == null) return -1;
    return aMs - bMs;
  });
  const lines = ordered.map((m) => {
    if (m.lastCastBeforeDeathMs == null) {
      return `  - ${m.abilityName}: not pressed this fight (CD ${m.cooldownSec}s)`;
    }
    const s = (m.lastCastBeforeDeathMs / 1000).toFixed(1);
    return `  - ${m.abilityName}: pressed ${s}s before death (CD ${m.cooldownSec}s)`;
  });

  const summary =
    `${playerName} (${playerClass ?? "unknown class"}) died at t=${new Date(deathTimestamp)
      .toISOString()
      .slice(11, 19)} in fight "${fight.name}" (fightID ${fight.id}).\n` +
    `Defensives seen in kit (${matched.length}):\n${lines.join("\n")}` +
    (activeBuffsAtDeath.length
      ? `\nActive buffs at death: ${activeBuffsAtDeath
          .map((b) => b.abilityName ?? `#${b.abilityID}`)
          .join(", ")}.`
      : "");

  return {
    reportCode: code,
    fightID: fight.id,
    fightName: fight.name,
    playerID,
    playerName,
    playerClass,
    deathTimestamp,
    matchedSpells: matched,
    unmatchedCasts: unmatched,
    activeBuffsAtDeath,
    summary,
  };
}
