import type { Ability, Actor, Fight, WclEvent } from "../wcl/client.js";
import { fetchAllEvents } from "../wcl/client.js";
import { wclReportUrl } from "../util/links.js";

export interface DeathMarker {
  fightID: number;
  attemptIndex: number;
  kill: boolean | null;
  timestamp: number;
  tIntoFightMs: number;
  playerName: string | null;
  playerClass: string | null;
  bossPercent: number | null;
  x: number | null;
  y: number | null;
  link: string;
}

export interface BossEventMarker {
  fightID: number;
  attemptIndex: number;
  timestamp: number;
  tIntoFightMs: number;
  abilityID: number | null;
  abilityName: string | null;
  type: string | null;
}

export interface TimelineReport {
  encounterID: number;
  encounterName: string;
  fightCount: number;
  deathMarkers: DeathMarker[];
  bossEvents: BossEventMarker[];
  bossAbilitySummary: Array<{
    abilityID: number;
    abilityName: string;
    count: number;
  }>;
  summary: string;
}

export async function buildDeathMapTimeline(args: {
  code: string;
  fights: Fight[];
  actors: Actor[];
  abilities?: Ability[];
  encounterID: number;
  encounterName: string;
  includeBossCasts?: boolean;
  maxBossEvents?: number;
}): Promise<TimelineReport> {
  const abilityNameByID = new Map<number, string>();
  for (const a of args.abilities ?? []) {
    if (a.name) abilityNameByID.set(a.gameID, a.name);
  }
  const relevant = args.fights.filter((f) => f.encounterID === args.encounterID);
  if (relevant.length === 0) {
    return {
      encounterID: args.encounterID,
      encounterName: args.encounterName,
      fightCount: 0,
      deathMarkers: [],
      bossEvents: [],
      bossAbilitySummary: [],
      summary: `No fights for encounter ${args.encounterName} (id ${args.encounterID}) in this report.`,
    };
  }

  const encounterAttemptIndex = new Map<number, number>();
  {
    let idx = 0;
    for (const f of args.fights) {
      if (f.encounterID === args.encounterID) {
        idx += 1;
        encounterAttemptIndex.set(f.id, idx);
      }
    }
  }

  const fightIDs = relevant.map((f) => f.id);
  const startTime = Math.min(...relevant.map((f) => f.startTime));
  const endTime = Math.max(...relevant.map((f) => f.endTime));

  const deathEvents = await fetchAllEvents({
    code: args.code,
    startTime,
    endTime,
    fightIDs,
    dataType: "Deaths",
    hostilityType: "Friendlies",
    includeResources: true,
  });

  const fightByID = new Map(relevant.map((f) => [f.id, f]));
  const deathMarkers: DeathMarker[] = deathEvents.flatMap((ev) => {
    const fightID =
      typeof ev.fight === "number"
        ? (ev.fight as number)
        : relevant.find((f) => ev.timestamp >= f.startTime && ev.timestamp <= f.endTime)?.id;
    if (fightID == null) return [];
    const fight = fightByID.get(fightID);
    if (!fight) return [];
    const actor = args.actors.find((a) => a.id === ev.targetID);
    return [
      {
        fightID,
        attemptIndex: encounterAttemptIndex.get(fightID) ?? 0,
        kill: fight.kill,
        timestamp: ev.timestamp,
        tIntoFightMs: ev.timestamp - fight.startTime,
        playerName: actor?.name ?? null,
        playerClass: actor?.subType ?? null,
        bossPercent: typeof ev.bossPercentage === "number" ? ev.bossPercentage : null,
        x: typeof ev.x === "number" ? ev.x : null,
        y: typeof ev.y === "number" ? ev.y : null,
        link: wclReportUrl({
          code: args.code,
          fightID,
          type: "deaths",
          start: ev.timestamp - fight.startTime - 5000,
          end: ev.timestamp - fight.startTime + 1000,
        }),
      },
    ];
  });

  let bossEvents: BossEventMarker[] = [];
  const bossAgg = new Map<number, { name: string | null; count: number }>();
  if (args.includeBossCasts) {
    const bossCasts = await fetchAllEvents({
      code: args.code,
      startTime,
      endTime,
      fightIDs,
      dataType: "Casts",
      hostilityType: "Enemies",
      maxEvents: args.maxBossEvents ?? 5000,
    });
    bossEvents = bossCasts.flatMap((ev) => {
      const fightID =
        typeof ev.fight === "number"
          ? (ev.fight as number)
          : relevant.find((f) => ev.timestamp >= f.startTime && ev.timestamp <= f.endTime)?.id;
      if (fightID == null) return [];
      const fight = fightByID.get(fightID);
      if (!fight) return [];
      const abilityID =
        typeof ev.abilityGameID === "number"
          ? ev.abilityGameID
          : typeof (ev.ability as { guid?: number } | undefined)?.guid === "number"
            ? (ev.ability as { guid: number }).guid
            : null;
      const rawName =
        typeof (ev.ability as { name?: string } | undefined)?.name === "string"
          ? (ev.ability as { name: string }).name
          : null;
      const abilityName =
        rawName ?? (abilityID != null ? abilityNameByID.get(abilityID) ?? null : null);
      if (abilityID != null) {
        const existing = bossAgg.get(abilityID) ?? { name: abilityName, count: 0 };
        existing.count += 1;
        if (!existing.name && abilityName) existing.name = abilityName;
        bossAgg.set(abilityID, existing);
      }
      return [
        {
          fightID,
          attemptIndex: encounterAttemptIndex.get(fightID) ?? 0,
          timestamp: ev.timestamp,
          tIntoFightMs: ev.timestamp - fight.startTime,
          abilityID,
          abilityName,
          type: typeof ev.type === "string" ? ev.type : null,
        },
      ];
    });
  }

  const bossAbilitySummary = [...bossAgg.entries()]
    .map(([id, v]) => ({ abilityID: id, abilityName: v.name ?? `#${id}`, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const deathsWithXY = deathMarkers.filter((d) => d.x != null && d.y != null).length;
  const summary =
    `Encounter ${args.encounterName} (id ${args.encounterID}): ${relevant.length} pull(s), ` +
    `${deathMarkers.length} death(s) recorded, ${deathsWithXY} with map coordinates. ` +
    (args.includeBossCasts
      ? `Captured ${bossEvents.length} boss cast event(s) for overlay.`
      : "Boss cast overlay not requested.");

  return {
    encounterID: args.encounterID,
    encounterName: args.encounterName,
    fightCount: relevant.length,
    deathMarkers,
    bossEvents,
    bossAbilitySummary,
    summary,
  };
}
