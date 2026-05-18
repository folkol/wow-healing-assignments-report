import { fetchAllEvents, getReportMeta, type Actor, type WclEvent } from "../wcl/client.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuditOptions {
  hitWindowSec?: number;
  actualWindowSec?: number;
  sampleOffsets?: number[];
  maxEvents?: number;
  spellMap?: Map<number, number>;
  playerMap?: Map<string, string>;
}

export interface PlanAssignment {
  index: number;
  timeSec: number;
  tag: string;
  actorID: number;
  originalSpellID: number;
  spellID: number;
  bossSpellID?: number;
  note?: string;
}

export interface ScoredAssignment extends PlanAssignment {
  fightID: number;
  attempt: number;
  fightStart: number;
  fightEnd: number;
  fightDurationSec: number;
  bossPct: number | null;
  actualSec?: number;
  actualTimestamp?: number;
  deltaSec?: number;
  status: "hit" | "early" | "late" | "miss";
  assignedDead: boolean;
  assignedDeathSec?: number;
}

export interface HealthSample {
  avgHp?: number;
  lowest: Array<{ actorID: number; hpPct: number }>;
  under50: number;
  dead: number;
  activeDebuffs: string;
  debuffChanges: string;
  deathsNear: string;
}

export interface PullDeath {
  attempt: number;
  fightID: number;
  timeSec: number;
  actorID: number;
  killingAbilityID?: number;
}

export interface DeathTimeBucket {
  startSec: number;
  endSec: number;
  count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default spell ID remaps applied when scoring. Can be overridden in options. */
export const DEFAULT_SPELL_MAP = new Map<number, number>([
  // WowUtils may export Chi-Ji (325197) while WCL logs the cast as Yu'lon (322118).
  [325197, 322118],
]);

const DEFAULT_OPTIONS: Required<Omit<AuditOptions, "spellMap" | "playerMap">> = {
  hitWindowSec: 8,
  actualWindowSec: 60,
  sampleOffsets: [-10, -5, 0, 5, 10],
  maxEvents: 250_000,
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export function extractReportCode(input: string): string {
  const match = input.match(/warcraftlogs\.com\/reports\/([A-Za-z0-9]+)/);
  return match?.[1] ?? input.trim();
}

function parseAssignmentFields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of line.matchAll(/([^:;]+):([^;]*);/g)) {
    out[match[1].trim()] = match[2].trim();
  }
  return out;
}

export function parseDifficulty(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isFinite(n)) return n;
  const map: Record<string, number> = { lfr: 1, normal: 3, heroic: 4, mythic: 5 };
  const out = map[value.toLowerCase()];
  if (!out) throw new Error(`Unknown difficulty: ${value}`);
  return out;
}

export function parseAssignmentsHeader(text: string): {
  encounterID?: number;
  difficulty?: number;
  name?: string;
} {
  const first = text.split(/\r?\n/).find((line) => line.trim());
  if (!first) return {};
  const fields = parseAssignmentFields(`${first};`);
  return {
    encounterID: fields.EncounterID ? Number.parseInt(fields.EncounterID, 10) : undefined,
    difficulty: fields.Difficulty ? parseDifficulty(fields.Difficulty) : undefined,
    name: fields.Name,
  };
}

function actorLookup(actors: Actor[], playerMap: Map<string, string>): Map<string, Actor> {
  const out = new Map<string, Actor>();
  for (const actor of actors) out.set(actor.name.toLowerCase(), actor);
  for (const [from, to] of playerMap) {
    const actor = out.get(to.toLowerCase());
    if (!actor) throw new Error(`--player-map target not found in report actors: ${to}`);
    out.set(from.toLowerCase(), actor);
  }
  return out;
}

export function parsePlan(
  text: string,
  actors: Actor[],
  spellMap: Map<number, number>,
  playerMap: Map<string, string>,
): PlanAssignment[] {
  const lookup = actorLookup(actors, playerMap);
  const plan: PlanAssignment[] = [];
  const missingPlayers = new Set<string>();

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line.startsWith("time:")) continue;
    const fields = parseAssignmentFields(line);
    if (!fields.spellid || !fields.tag || fields.tag === "everyone") continue;
    const actor = lookup.get(fields.tag.toLowerCase());
    if (!actor) {
      missingPlayers.add(fields.tag);
      continue;
    }
    const originalSpellID = Number.parseInt(fields.spellid, 10);
    const spellID = spellMap.get(originalSpellID) ?? originalSpellID;
    plan.push({
      index,
      timeSec: Number.parseInt(fields.time, 10),
      tag: fields.tag,
      actorID: actor.id,
      originalSpellID,
      spellID,
      bossSpellID: fields.bossSpell ? Number.parseInt(fields.bossSpell, 10) : undefined,
      note: spellID !== originalSpellID ? `mapped ${originalSpellID}->${spellID}` : undefined,
    });
  }

  if (missingPlayers.size > 0) {
    throw new Error(
      `Assignments reference players not found in WCL report: ${[...missingPlayers].join(", ")}`,
    );
  }
  if (plan.length === 0) throw new Error("No spell assignments found in assignment text.");
  return plan;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function numberField(event: WclEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(event: WclEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

function fmtTime(sec?: number): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  const sign = sec < 0 ? "-" : "";
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = Math.round(abs - m * 60);
  return `${sign}${m}:${s.toString().padStart(2, "0")}`;
}

export function scoreAssignments(params: {
  plan: PlanAssignment[];
  fights: Array<{
    id: number;
    startTime: number;
    endTime: number;
    fightPercentage: number | null;
    bossPercentage: number | null;
    attempt: number;
  }>;
  casts: WclEvent[];
  hitWindowSec: number;
  actualWindowSec: number;
}): ScoredAssignment[] {
  const castsByKey = new Map<string, WclEvent[]>();
  for (const event of params.casts) {
    if (event.type !== "cast") continue;
    const key = `${event.fight}:${event.sourceID}:${event.abilityGameID}`;
    const list = castsByKey.get(key) ?? [];
    list.push(event);
    castsByKey.set(key, list);
  }
  for (const list of castsByKey.values()) list.sort((a, b) => a.timestamp - b.timestamp);

  const out: ScoredAssignment[] = [];
  const assignmentsByKey = new Map<string, ScoredAssignment[]>();

  for (const fight of params.fights) {
    const durationSec = (fight.endTime - fight.startTime) / 1000;
    for (const item of params.plan) {
      if (item.timeSec > durationSec + 0.25) continue;
      const assignment: ScoredAssignment = {
        ...item,
        fightID: fight.id,
        attempt: fight.attempt,
        fightStart: fight.startTime,
        fightEnd: fight.endTime,
        fightDurationSec: durationSec,
        bossPct: fight.bossPercentage ?? fight.fightPercentage,
        status: "miss",
        assignedDead: false,
      };
      const key = `${fight.id}:${item.actorID}:${item.spellID}`;
      const list = assignmentsByKey.get(key) ?? [];
      list.push(assignment);
      assignmentsByKey.set(key, list);
      out.push(assignment);
    }
  }

  for (const [key, assignments] of assignmentsByKey) {
    assignments.sort((a, b) => a.timeSec - b.timeSec);
    const casts = castsByKey.get(key) ?? [];
    const used = new Set<number>();
    for (const assignment of assignments) {
      let best:
        | { index: number; actualSec: number; timestamp: number; deltaSec: number; absDelta: number }
        | undefined;
      for (const [index, event] of casts.entries()) {
        if (used.has(index)) continue;
        const actualSec = (event.timestamp - assignment.fightStart) / 1000;
        const deltaSec = actualSec - assignment.timeSec;
        const absDelta = Math.abs(deltaSec);
        if (absDelta > params.actualWindowSec) continue;
        if (!best || absDelta < best.absDelta) {
          best = { index, actualSec, timestamp: event.timestamp, deltaSec, absDelta };
        }
      }
      if (!best) continue;
      used.add(best.index);
      assignment.actualSec = best.actualSec;
      assignment.actualTimestamp = best.timestamp;
      assignment.deltaSec = best.deltaSec;
      assignment.status =
        best.absDelta <= params.hitWindowSec ? "hit" : best.deltaSec < 0 ? "early" : "late";
    }
  }

  return out.sort((a, b) => a.attempt - b.attempt || a.timeSec - b.timeSec || a.index - b.index);
}

// ---------------------------------------------------------------------------
// Death annotation
// ---------------------------------------------------------------------------

type DeathEvent = { timestamp: number; actorID: number; kind: "death" | "res" };

export function buildDeathState(events: WclEvent[]): Map<number, DeathEvent[]> {
  const byFight = new Map<number, DeathEvent[]>();
  for (const event of events) {
    const fight = numberField(event, "fight");
    const actorID = event.targetID;
    if (!fight || !actorID) continue;
    const list = byFight.get(fight) ?? [];
    list.push({
      timestamp: event.timestamp,
      actorID,
      kind: event.type === "death" ? "death" : "res",
    });
    byFight.set(fight, list);
  }
  for (const list of byFight.values()) list.sort((a, b) => a.timestamp - b.timestamp);
  return byFight;
}

export function annotateDeaths(
  assignments: ScoredAssignment[],
  deathState: Map<number, DeathEvent[]>,
): void {
  for (const assignment of assignments) {
    const plannedTs = assignment.fightStart + assignment.timeSec * 1000;
    let dead = false;
    let deathTs: number | undefined;
    for (const event of deathState.get(assignment.fightID) ?? []) {
      if (event.timestamp > plannedTs) break;
      if (event.actorID !== assignment.actorID) continue;
      if (event.kind === "death") {
        dead = true;
        deathTs = event.timestamp;
      } else {
        dead = false;
        deathTs = undefined;
      }
    }
    assignment.assignedDead = dead;
    assignment.assignedDeathSec =
      deathTs == null ? undefined : (deathTs - assignment.fightStart) / 1000;
  }
}

export function buildPullDeaths(params: {
  deathEvents: WclEvent[];
  fights: Array<{ id: number; startTime: number; attempt: number }>;
  playerIDs: Set<number>;
}): PullDeath[] {
  const fightByID = new Map(params.fights.map((f) => [f.id, f]));
  const out: PullDeath[] = [];
  for (const event of params.deathEvents) {
    if (event.type !== "death") continue;
    const fight = numberField(event, "fight");
    const targetID = event.targetID;
    if (!fight || !targetID || !params.playerIDs.has(targetID)) continue;
    const fightMeta = fightByID.get(fight);
    if (!fightMeta) continue;
    const killingAbilityID =
      numberField(event, "killingAbilityGameID") ?? numberField(event, "abilityGameID");
    out.push({
      attempt: fightMeta.attempt,
      fightID: fight,
      timeSec: (event.timestamp - fightMeta.startTime) / 1000,
      actorID: targetID,
      killingAbilityID,
    });
  }
  return out.sort((a, b) => a.attempt - b.attempt || a.timeSec - b.timeSec);
}

/** Ignore wipe-call deaths — only the first N deaths per pull count toward stats and timeline. */
export const MAX_DEATHS_PER_PULL = 5;

export function limitDeathsPerPull(
  deaths: PullDeath[],
  maxPerPull = MAX_DEATHS_PER_PULL,
): PullDeath[] {
  const byPull = new Map<number, PullDeath[]>();
  for (const death of deaths) {
    const list = byPull.get(death.attempt) ?? [];
    list.push(death);
    byPull.set(death.attempt, list);
  }
  const out: PullDeath[] = [];
  for (const list of byPull.values()) {
    list.sort((a, b) => a.timeSec - b.timeSec);
    out.push(...list.slice(0, maxPerPull));
  }
  return out.sort((a, b) => a.attempt - b.attempt || a.timeSec - b.timeSec);
}

const DEATH_BUCKET_SEC = 5;

/** Continuous time buckets for the aggregate death histogram (includes zero-count buckets). */
export function buildDeathHistogramBuckets(
  deaths: PullDeath[],
  maxTimeSec: number,
  bucketSec = DEATH_BUCKET_SEC,
): DeathTimeBucket[] {
  if (maxTimeSec <= 0) return [];
  const buckets: DeathTimeBucket[] = [];
  for (let start = 0; start < maxTimeSec; start += bucketSec) {
    const end = Math.min(start + bucketSec, maxTimeSec);
    const count = deaths.filter((d) => d.timeSec >= start && d.timeSec < end).length;
    buckets.push({ startSec: start, endSec: end, count });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Health samples
// ---------------------------------------------------------------------------

export function buildHealthSamples(params: {
  assignments: ScoredAssignment[];
  healthEvents: WclEvent[];
  debuffEvents: WclEvent[];
  deathState: Map<number, DeathEvent[]>;
  playerIDs: Set<number>;
  actorNames: Map<number, string>;
  actorsByID: Map<number, Actor>;
  abilityNames: Map<number, string>;
  sampleOffsets: number[];
}): Map<string, HealthSample> {
  const samples = new Map<string, HealthSample>();
  const requestsByFight = new Map<
    number,
    Array<{ timestamp: number; assignmentIndex: number; offset: number }>
  >();
  for (const [assignmentIndex, assignment] of params.assignments.entries()) {
    for (const offset of params.sampleOffsets) {
      const timestamp = assignment.fightStart + (assignment.timeSec + offset) * 1000;
      if (timestamp < assignment.fightStart || timestamp > assignment.fightEnd) continue;
      const list = requestsByFight.get(assignment.fightID) ?? [];
      list.push({ timestamp, assignmentIndex, offset });
      requestsByFight.set(assignment.fightID, list);
    }
  }

  const healthByFight = new Map<number, WclEvent[]>();
  for (const event of params.healthEvents) {
    const fight = numberField(event, "fight");
    if (!fight || !params.playerIDs.has(event.targetID ?? -1)) continue;
    if (numberField(event, "hitPoints") == null || numberField(event, "maxHitPoints") == null)
      continue;
    const list = healthByFight.get(fight) ?? [];
    list.push(event);
    healthByFight.set(fight, list);
  }
  for (const list of healthByFight.values()) list.sort((a, b) => a.timestamp - b.timestamp);

  const debuffsByFight = new Map<number, WclEvent[]>();
  for (const event of params.debuffEvents) {
    const fight = numberField(event, "fight");
    if (!fight || !params.playerIDs.has(event.targetID ?? -1)) continue;
    if (!stringField(event, "type")?.toLowerCase().includes("debuff")) continue;
    const list = debuffsByFight.get(fight) ?? [];
    list.push(event);
    debuffsByFight.set(fight, list);
  }
  for (const list of debuffsByFight.values()) list.sort((a, b) => a.timestamp - b.timestamp);

  for (const [fightID, requests] of requestsByFight) {
    requests.sort((a, b) => a.timestamp - b.timestamp);
    const healthEvents = healthByFight.get(fightID) ?? [];
    const deathEvents = params.deathState.get(fightID) ?? [];
    const debuffEvents = debuffsByFight.get(fightID) ?? [];
    const healthState = new Map<number, { hp: number; maxHp: number }>();
    const deadState = new Set<number>();
    let healthIndex = 0;
    let deathIndex = 0;

    for (const request of requests) {
      while (
        healthIndex < healthEvents.length &&
        healthEvents[healthIndex].timestamp <= request.timestamp
      ) {
        const event = healthEvents[healthIndex++];
        const targetID = event.targetID;
        const hp = numberField(event, "hitPoints");
        const maxHp = numberField(event, "maxHitPoints");
        if (targetID && hp != null && maxHp != null && maxHp > 0) {
          healthState.set(targetID, { hp, maxHp });
        }
      }
      while (
        deathIndex < deathEvents.length &&
        deathEvents[deathIndex].timestamp <= request.timestamp
      ) {
        const event = deathEvents[deathIndex++];
        if (event.kind === "death") deadState.add(event.actorID);
        else deadState.delete(event.actorID);
      }

      const values: Array<{ actorID: number; hpPct: number }> = [];
      for (const actorID of params.playerIDs) {
        if (deadState.has(actorID)) {
          values.push({ actorID, hpPct: 0 });
          continue;
        }
        const hp = healthState.get(actorID);
        if (!hp) continue;
        values.push({ actorID, hpPct: Math.max(0, Math.min(100, (hp.hp / hp.maxHp) * 100)) });
      }
      const avgHp =
        values.length > 0
          ? values.reduce((sum, v) => sum + v.hpPct, 0) / values.length
          : undefined;
      const lowest = [...values].sort((a, b) => a.hpPct - b.hpPct).slice(0, 5);
      const under50 = values.filter((v) => v.hpPct < 50).length;
      const activeDebuffs = activeDebuffSummary(debuffEvents, request.timestamp, params.abilityNames);
      const debuffChanges = debuffChangeSummary(
        debuffEvents,
        request.timestamp - 2500,
        request.timestamp + 2500,
        params.abilityNames,
      );
      const deathsNear = deathsNearSummary(
        deathEvents,
        request.timestamp - 2500,
        request.timestamp + 2500,
        params.actorsByID,
      );
      samples.set(`${request.assignmentIndex}:${request.offset}`, {
        avgHp,
        lowest,
        under50,
        dead: [...deadState].filter((id) => params.playerIDs.has(id)).length,
        activeDebuffs,
        debuffChanges,
        deathsNear,
      });
    }
  }
  return samples;
}

function activeDebuffSummary(
  events: WclEvent[],
  timestamp: number,
  abilityNames: Map<number, string>,
): string {
  const active = new Map<string, number>();
  for (const event of events) {
    if (event.timestamp > timestamp) break;
    const type = event.type ?? "";
    const targetID = event.targetID;
    const abilityID = event.abilityGameID;
    if (!targetID || !abilityID) continue;
    const key = `${targetID}:${abilityID}`;
    if (type.startsWith("apply") || type.startsWith("refresh")) active.set(key, abilityID);
    if (type.startsWith("remove")) active.delete(key);
  }
  const counts = new Map<number, number>();
  for (const abilityID of active.values())
    counts.set(abilityID, (counts.get(abilityID) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id, cnt]) => `${abilityNames.get(id) ?? id} x${cnt}`)
    .join(", ");
}

function debuffChangeSummary(
  events: WclEvent[],
  start: number,
  end: number,
  abilityNames: Map<number, string>,
): string {
  const counts = new Map<string, { sign: string; abilityID: number; count: number }>();
  for (const event of events) {
    if (event.timestamp < start) continue;
    if (event.timestamp > end) break;
    const abilityID = event.abilityGameID;
    if (!abilityID) continue;
    const type = event.type ?? "";
    const sign = type.startsWith("remove")
      ? "-"
      : type.startsWith("apply") || type.startsWith("refresh")
        ? "+"
        : "~";
    const key = `${sign}:${abilityID}`;
    const entry = counts.get(key) ?? { sign, abilityID, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((e) => `${e.sign}${abilityNames.get(e.abilityID) ?? e.abilityID} x${e.count}`)
    .join("; ");
}

function deathsNearSummary(
  events: DeathEvent[],
  start: number,
  end: number,
  actorsByID: Map<number, Actor>,
): string {
  const names: string[] = [];
  for (const event of events) {
    if (event.kind !== "death") continue;
    if (event.timestamp < start || event.timestamp > end) continue;
    names.push(actorsByID.get(event.actorID)?.name ?? String(event.actorID));
  }
  return names.join(", ");
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function htmlEscape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusClass(status: ScoredAssignment["status"]): string {
  if (status === "hit") return "ok";
  if (status === "miss") return "bad";
  return "warn";
}

function renderAssignmentSummaryTimeline(params: {
  assignments: ScoredAssignment[];
  deathHistogram: DeathTimeBucket[];
  totalDeaths: number;
  actorsByID: Map<number, Actor>;
  abilityNames: Map<number, string>;
}): string {
  if (params.deathHistogram.length === 0) return "";

  const maxTimeSec = params.deathHistogram.at(-1)?.endSec ?? 1;
  const maxCount = Math.max(...params.deathHistogram.map((b) => b.count), 1);
  const peakThreshold = Math.max(2, Math.ceil(maxCount * 0.45));

  const deathBars = params.deathHistogram
    .map((bucket) => {
      const isPeak = bucket.count >= peakThreshold;
      const heightPct = bucket.count === 0 ? 0 : Math.max(6, (bucket.count / maxCount) * 100);
      const tip = `${fmtTime(bucket.startSec)}–${fmtTime(bucket.endSec)}: ${bucket.count} death${
        bucket.count === 1 ? "" : "s"
      }`;
      return `<div class="death-bar${bucket.count === 0 ? " empty" : ""}${
        isPeak ? " peak" : ""
      }" style="height:${heightPct}%" title="${htmlEscape(tip)}"></div>`;
    })
    .join("");

  const groups = new Map<number, ScoredAssignment[]>();
  for (const assignment of params.assignments) {
    const group = groups.get(assignment.index) ?? [];
    group.push(assignment);
    groups.set(assignment.index, group);
  }
  const markers = [...groups.values()]
    .sort((a, b) => a[0].timeSec - b[0].timeSec || a[0].index - b[0].index)
    .map((group) => {
      const first = group[0];
      const hit = group.filter((a) => a.status === "hit").length;
      const rateClass =
        hit / group.length >= 0.9 ? "ok" : hit / group.length >= 0.7 ? "warn" : "bad";
      const leftPct = Math.min(100, Math.max(0, (first.timeSec / maxTimeSec) * 100));
      const actor = params.actorsByID.get(first.actorID)?.name ?? first.tag;
      const spellName = params.abilityNames.get(first.spellID) ?? first.spellID;
      const tip = `${fmtTime(first.timeSec)} ${actor} – ${spellName} (${hit}/${group.length} hits)`;
      return `<span class="assign-marker ${rateClass}" style="left:${leftPct.toFixed(2)}%" title="${htmlEscape(tip)}"></span>`;
    })
    .join("");

  const mid = params.deathHistogram[Math.floor(params.deathHistogram.length / 2)];
  return `<div class="summary-timeline">
  <div class="summary-timeline-track">
    <div class="death-bars">${deathBars}</div>
    <div class="assign-markers">${markers}</div>
  </div>
  <div class="summary-timeline-axis">
    <span>0:00</span>
    <span>${fmtTime(mid?.startSec ?? 0)}</span>
    <span>${fmtTime(maxTimeSec)}</span>
  </div>
  <div class="summary-timeline-legend">
    <span><i class="legend-swatch death-swatch"></i> Deaths (${params.totalDeaths}, first ${MAX_DEATHS_PER_PULL}/pull)</span>
    <span><i class="legend-swatch assign-swatch ok"></i> Assignment on-time rate</span>
  </div>
</div>`;
}

function renderPullTimelineRows(params: {
  assignments: ScoredAssignment[];
  pullDeaths: PullDeath[];
  samples: Map<string, HealthSample>;
  actorsByID: Map<number, Actor>;
  abilityNames: Map<number, string>;
  sampleOffsets: number[];
}): string {
  type TimelineEntry =
    | { kind: "assignment"; assignment: ScoredAssignment; assignmentIndex: number }
    | { kind: "death"; death: PullDeath };

  const entries: TimelineEntry[] = params.assignments.map((assignment, assignmentIndex) => ({
    kind: "assignment",
    assignment,
    assignmentIndex,
  }));
  for (const death of params.pullDeaths) entries.push({ kind: "death", death });

  entries.sort((a, b) => {
    const attemptA = a.kind === "assignment" ? a.assignment.attempt : a.death.attempt;
    const attemptB = b.kind === "assignment" ? b.assignment.attempt : b.death.attempt;
    if (attemptA !== attemptB) return attemptA - attemptB;
    const timeA = a.kind === "assignment" ? a.assignment.timeSec : a.death.timeSec;
    const timeB = b.kind === "assignment" ? b.assignment.timeSec : b.death.timeSec;
    if (timeA !== timeB) return timeA - timeB;
    return a.kind === "assignment" ? -1 : 1;
  });

  return entries
    .map((entry) => {
      if (entry.kind === "death") {
        const { death } = entry;
        const player = params.actorsByID.get(death.actorID)?.name ?? death.actorID;
        const killingBlow = death.killingAbilityID
          ? params.abilityNames.get(death.killingAbilityID) ?? death.killingAbilityID
          : "";
        return `<tr class="death">
  <td>${death.attempt}</td>
  <td>${fmtTime(death.timeSec)}</td>
  <td></td>
  <td></td>
  <td>death</td>
  <td>${htmlEscape(player)}</td>
  <td>${htmlEscape(killingBlow)}</td>
  <td></td>
  <td></td>
  <td></td>
</tr>`;
      }

      const { assignment, assignmentIndex } = entry;
      const actor = params.actorsByID.get(assignment.actorID);
      const spellName = params.abilityNames.get(assignment.spellID) ?? assignment.spellID;
      const spell =
        assignment.originalSpellID === assignment.spellID
          ? `${spellName} (${assignment.spellID})`
          : `${spellName} (${assignment.originalSpellID} -> ${assignment.spellID})`;
      const actual = assignment.actualSec == null ? "none nearby" : fmtTime(assignment.actualSec);
      const delta =
        assignment.deltaSec == null
          ? ""
          : `${assignment.deltaSec >= 0 ? "+" : ""}${assignment.deltaSec.toFixed(1)}s`;
      const deathCtx = assignment.assignedDead
        ? `dead since ${fmtTime(assignment.assignedDeathSec)}`
        : "";
      return `<tr class="${statusClass(assignment.status)}">
  <td>${assignment.attempt}</td>
  <td>${fmtTime(assignment.timeSec)}</td>
  <td>${htmlEscape(actual)}</td>
  <td>${htmlEscape(delta)}</td>
  <td>${assignment.status}</td>
  <td>${htmlEscape(actor?.name ?? assignment.tag)}</td>
  <td>${htmlEscape(spell)}</td>
  <td>${htmlEscape(assignment.bossSpellID ?? "")}</td>
  <td>${htmlEscape(deathCtx)}</td>
  <td><details><summary>health/debuff timeline</summary>${renderSampleTable(
    assignmentIndex,
    params.samples,
    params.actorsByID,
    params.sampleOffsets,
  )}</details></td>
</tr>`;
    })
    .join("\n");
}

function renderSampleTable(
  assignmentIndex: number,
  samples: Map<string, HealthSample>,
  actorsByID: Map<number, Actor>,
  sampleOffsets: number[],
): string {
  const rows = sampleOffsets
    .map((offset) => {
      const sample = samples.get(`${assignmentIndex}:${offset}`);
      if (!sample) return "";
      const lowest = sample.lowest
        .map((e) => `${actorsByID.get(e.actorID)?.name ?? e.actorID} ${e.hpPct.toFixed(0)}%`)
        .join(", ");
      return `<tr><td>${offset >= 0 ? "+" : ""}${offset}s</td><td>${
        sample.avgHp == null ? "" : `${sample.avgHp.toFixed(0)}%`
      }</td><td>${htmlEscape(lowest)}</td><td>${sample.under50}</td><td>${
        sample.dead
      }</td><td>${htmlEscape(sample.activeDebuffs || "none")}</td><td>${htmlEscape(
        sample.debuffChanges || "none",
      )}</td><td>${htmlEscape(sample.deathsNear || "none")}</td></tr>`;
    })
    .join("");
  return `<table class="inner"><thead><tr><th>Rel</th><th>Avg HP</th><th>Lowest HP</th><th>&lt;50%</th><th>Dead</th><th>Active Debuffs</th><th>Debuff Changes (+/-2.5s)</th><th>Deaths (+/-2.5s)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderAssignmentSummaryRows(
  assignments: ScoredAssignment[],
  actorsByID: Map<number, Actor>,
  abilityNames: Map<number, string>,
): string {
  const groups = new Map<number, ScoredAssignment[]>();
  for (const assignment of assignments) {
    const group = groups.get(assignment.index) ?? [];
    group.push(assignment);
    groups.set(assignment.index, group);
  }
  return [...groups.values()]
    .sort((a, b) => a[0].timeSec - b[0].timeSec || a[0].index - b[0].index)
    .map((group) => {
      const first = group[0];
      const actor = actorsByID.get(first.actorID);
      const spellName = abilityNames.get(first.spellID) ?? first.spellID;
      const spell =
        first.originalSpellID === first.spellID
          ? `${spellName} (${first.spellID})`
          : `${spellName} (${first.originalSpellID} -> ${first.spellID})`;
      const statusCounts = new Map<ScoredAssignment["status"], number>();
      for (const assignment of group)
        statusCounts.set(assignment.status, (statusCounts.get(assignment.status) ?? 0) + 1);
      const deathNonHits = group.filter(
        (a) => a.status !== "hit" && a.assignedDead,
      ).length;
      const deltas = group
        .map((a) => a.deltaSec)
        .filter((d): d is number => d != null)
        .sort((a, b) => a - b);
      const medianDelta =
        deltas.length === 0
          ? ""
          : `${deltas[Math.floor(deltas.length / 2)] >= 0 ? "+" : ""}${deltas[
              Math.floor(deltas.length / 2)
            ].toFixed(1)}s`;
      const worstPulls = group
        .filter((a) => a.status !== "hit")
        .slice(0, 8)
        .map((a) => {
          const death = a.assignedDead ? " dead" : "";
          const delta =
            a.deltaSec == null
              ? ""
              : ` ${a.deltaSec >= 0 ? "+" : ""}${a.deltaSec.toFixed(1)}s`;
          return `P${a.attempt} ${a.status}${delta}${death}`;
        })
        .join(", ");
      const hit = statusCounts.get("hit") ?? 0;
      const rateClass = hit / group.length >= 0.9 ? "ok" : hit / group.length >= 0.7 ? "warn" : "bad";
      return `<tr class="${rateClass}">
  <td>${fmtTime(first.timeSec)}</td>
  <td>${htmlEscape(actor?.name ?? first.tag)}</td>
  <td>${htmlEscape(spell)}</td>
  <td>${group.length}</td>
  <td>${hit}</td>
  <td>${statusCounts.get("early") ?? 0}</td>
  <td>${statusCounts.get("late") ?? 0}</td>
  <td>${statusCounts.get("miss") ?? 0}</td>
  <td>${deathNonHits}</td>
  <td>${htmlEscape(medianDelta)}</td>
  <td>${htmlEscape(worstPulls)}</td>
</tr>`;
    })
    .join("\n");
}

export function renderHtml(params: {
  reportCode: string;
  reportTitle: string;
  assignments: ScoredAssignment[];
  samples: Map<string, HealthSample>;
  actorsByID: Map<number, Actor>;
  abilityNames: Map<number, string>;
  sampleOffsets: number[];
  pullDeaths: PullDeath[];
  deathHistogram: DeathTimeBucket[];
}): string {
  const counts = new Map<ScoredAssignment["status"], number>();
  for (const assignment of params.assignments)
    counts.set(assignment.status, (counts.get(assignment.status) ?? 0) + 1);

  const summaryRows = renderAssignmentSummaryRows(
    params.assignments,
    params.actorsByID,
    params.abilityNames,
  );

  const summaryTimeline = renderAssignmentSummaryTimeline({
    assignments: params.assignments,
    deathHistogram: params.deathHistogram,
    totalDeaths: params.pullDeaths.length,
    actorsByID: params.actorsByID,
    abilityNames: params.abilityNames,
  });
  const timelineRows = renderPullTimelineRows({
    assignments: params.assignments,
    pullDeaths: params.pullDeaths,
    samples: params.samples,
    actorsByID: params.actorsByID,
    abilityNames: params.abilityNames,
    sampleOffsets: params.sampleOffsets,
  });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Cooldown Assignment Timeline Audit</title>
<style>
:root { color-scheme: dark; }
body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 24px; background: #111; color: #eee; }
h1 { margin-bottom: 0; }
.meta { color: #aaa; margin: 8px 0 20px; }
.summary { display: flex; gap: 16px; flex-wrap: wrap; margin: 18px 0; }
.card { border: 1px solid #333; border-radius: 8px; padding: 12px 16px; background: #181818; }
.card b { font-size: 22px; display: block; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border-bottom: 1px solid #333; padding: 7px 8px; vertical-align: top; }
th { position: sticky; top: 0; background: #202020; z-index: 1; text-align: left; }
tr.ok { background: rgba(40,130,70,.12); }
tr.warn { background: rgba(180,130,20,.14); }
tr.bad { background: rgba(160,50,50,.16); }
tr.death { background: rgba(40, 160, 160, 0.12); }
.inner { margin: 10px 0; font-size: 12px; background: #151515; }
.inner th { position: static; }
.summary-timeline { border: 1px solid #333; border-radius: 8px; padding: 14px 14px 10px; background: #181818; margin: 12px 0 18px; }
.summary-timeline-track { position: relative; height: 88px; }
.death-bars { display: flex; align-items: flex-end; gap: 2px; height: 100%; }
.death-bar { flex: 1; min-width: 3px; background: linear-gradient(to top, #1a5a5a, #38b0b0); border-radius: 2px 2px 0 0; cursor: default; }
.death-bar.peak { background: linear-gradient(to top, #22a0a0, #5ee0e0); box-shadow: 0 0 10px rgba(64, 224, 224, 0.35); }
.death-bar.empty { background: #222; min-height: 0; box-shadow: none; }
.death-bar:not(.empty):hover { filter: brightness(1.15); }
.assign-markers { position: absolute; inset: 0; pointer-events: none; }
.assign-marker { position: absolute; bottom: 0; top: 0; width: 2px; margin-left: -1px; pointer-events: auto; cursor: help; z-index: 2; border-radius: 1px; }
.assign-marker.ok { background: rgba(74, 222, 128, 0.95); box-shadow: 0 0 6px rgba(74, 222, 128, 0.5); }
.assign-marker.warn { background: rgba(250, 204, 21, 0.95); box-shadow: 0 0 6px rgba(250, 204, 21, 0.45); }
.assign-marker.bad { background: rgba(248, 113, 113, 0.95); box-shadow: 0 0 6px rgba(248, 113, 113, 0.45); }
.summary-timeline-axis { display: flex; justify-content: space-between; font-size: 11px; color: #888; margin-top: 8px; padding: 0 2px; }
.summary-timeline-legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 10px; font-size: 11px; color: #8898b8; }
.legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: 6px; vertical-align: -2px; }
.death-swatch { background: linear-gradient(to top, #1a5a5a, #5ee0e0); }
.assign-swatch.ok { background: #4ade80; }
summary { cursor: pointer; color: #9ecbff; }
</style>
</head>
<body>
<h1>Cooldown Assignment Timeline Audit</h1>
<div class="meta">Report ${htmlEscape(params.reportTitle)} (${params.reportCode}). Reached assignments only. Health samples use latest known player HP from healing/damage resource snapshots. Actual casts are nearest same-player/same-spell casts within the configured actual window.</div>
<div class="summary">
  <div class="card"><b>${params.assignments.length}</b>Reached assignments</div>
  <div class="card"><b>${counts.get("hit") ?? 0}</b>On-time casts</div>
  <div class="card"><b>${(counts.get("early") ?? 0) + (counts.get("late") ?? 0)}</b>Off-timing casts</div>
  <div class="card"><b>${counts.get("miss") ?? 0}</b>No nearby cast</div>
  <div class="card"><b>${params.pullDeaths.length}</b>Raid deaths</div>
</div>
<h2>Assignment Summary Over the Evening</h2>
<div class="meta">One row per planned assignment. Cyan bars show when deaths happen across all pulls; vertical lines mark each assignment (green/yellow/red = hit rate). Hover for details.</div>
${summaryTimeline}
<table>
<thead><tr><th>Assigned</th><th>Player</th><th>Spell</th><th>Reached</th><th>Hit</th><th>Early</th><th>Late</th><th>Miss</th><th>Death non-hit</th><th>Median Delta</th><th>Worst Pulls</th></tr></thead>
<tbody>
${summaryRows}
</tbody>
</table>
<h2>Per-Pull Timeline</h2>
<div class="meta">Assignments and deaths in chronological order per pull. Death rows show the player and killing blow (first ${MAX_DEATHS_PER_PULL} deaths per pull only).</div>
<table>
<thead><tr><th>Pull</th><th>Time</th><th>Actual</th><th>Delta</th><th>Status</th><th>Player</th><th>Spell / Killing Blow</th><th>Boss Spell</th><th>Death Context</th><th>Timeline</th></tr></thead>
<tbody>
${timelineRows}
</tbody>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main entry point shared by CLI and API
// ---------------------------------------------------------------------------

export async function generateAuditHtml(params: {
  reportCode: string;
  assignmentText: string;
  encounterID: number;
  difficulty: number;
  options?: AuditOptions;
  onProgress?: (message: string) => void;
}): Promise<string> {
  const log = params.onProgress ?? (() => undefined);
  const opts = {
    ...DEFAULT_OPTIONS,
    spellMap: new Map(DEFAULT_SPELL_MAP),
    playerMap: new Map<string, string>(),
    ...params.options,
  };

  log(`Fetching report metadata for ${params.reportCode}...`);
  const meta = await getReportMeta(params.reportCode);
  const selectedFights = meta.fights
    .filter((f) => f.encounterID === params.encounterID && f.difficulty === params.difficulty)
    .map((f, i) => ({ ...f, attempt: i + 1 }));
  if (selectedFights.length === 0) {
    throw new Error(
      `No fights found for encounter ${params.encounterID}, difficulty ${params.difficulty}.`,
    );
  }

  const plan = parsePlan(params.assignmentText, meta.actors, opts.spellMap, opts.playerMap);
  const spellIDs = [...new Set(plan.map((a) => a.spellID))].sort((a, b) => a - b);
  const startTime = Math.min(...selectedFights.map((f) => f.startTime));
  const endTime = Math.max(...selectedFights.map((f) => f.endTime));
  const fightIDs = selectedFights.map((f) => f.id);

  log(`Fetching casts for ${spellIDs.length} spell IDs across ${selectedFights.length} pulls...`);
  const casts = await fetchAllEvents({
    code: params.reportCode,
    startTime,
    endTime,
    fightIDs,
    dataType: "Casts",
    hostilityType: "Friendlies",
    filterExpression: `ability.id in (${spellIDs.join(",")})`,
    maxEvents: opts.maxEvents,
  });

  const assignments = scoreAssignments({
    plan,
    fights: selectedFights,
    casts,
    hitWindowSec: opts.hitWindowSec,
    actualWindowSec: opts.actualWindowSec,
  });

  log("Fetching deaths and resurrections...");
  const [deaths, resurrections] = await Promise.all([
    fetchAllEvents({
      code: params.reportCode,
      startTime,
      endTime,
      fightIDs,
      dataType: "Deaths",
      hostilityType: "Friendlies",
      maxEvents: opts.maxEvents,
    }),
    fetchAllEvents({
      code: params.reportCode,
      startTime,
      endTime,
      fightIDs,
      dataType: "All",
      hostilityType: "Friendlies",
      filterExpression: 'type = "resurrect"',
      maxEvents: opts.maxEvents,
    }),
  ]);
  const deathState = buildDeathState([...deaths, ...resurrections]);
  annotateDeaths(assignments, deathState);

  log("Fetching health and debuff streams...");
  const [damage, healing, debuffs] = await Promise.all([
    fetchAllEvents({
      code: params.reportCode,
      startTime,
      endTime,
      fightIDs,
      dataType: "DamageTaken",
      hostilityType: "Friendlies",
      includeResources: true,
      maxEvents: opts.maxEvents,
    }),
    fetchAllEvents({
      code: params.reportCode,
      startTime,
      endTime,
      fightIDs,
      dataType: "Healing",
      hostilityType: "Friendlies",
      includeResources: true,
      maxEvents: opts.maxEvents,
    }),
    fetchAllEvents({
      code: params.reportCode,
      startTime,
      endTime,
      fightIDs,
      dataType: "Debuffs",
      hostilityType: "Friendlies",
      maxEvents: opts.maxEvents,
    }),
  ]);

  const actorsByID = new Map(meta.actors.map((a) => [a.id, a]));
  const abilityNames = new Map(meta.abilities.map((a) => [a.gameID, a.name]));
  const playerIDs = new Set(meta.actors.map((a) => a.id));
  const raidPlayerIDs = new Set(
    meta.actors.filter((a) => a.type.toLowerCase() === "player").map((a) => a.id),
  );

  const pullDeaths = limitDeathsPerPull(
    buildPullDeaths({
      deathEvents: deaths,
      fights: selectedFights,
      playerIDs: raidPlayerIDs.size > 0 ? raidPlayerIDs : playerIDs,
    }),
  );
  const maxFightDurationSec = Math.max(
    ...selectedFights.map((f) => (f.endTime - f.startTime) / 1000),
  );
  const deathHistogram = buildDeathHistogramBuckets(pullDeaths, maxFightDurationSec);

  const samples = buildHealthSamples({
    assignments,
    healthEvents: [...damage, ...healing],
    debuffEvents: debuffs,
    deathState,
    playerIDs,
    actorNames: new Map(meta.actors.map((a) => [a.id, a.name])),
    actorsByID,
    abilityNames,
    sampleOffsets: opts.sampleOffsets,
  });

  return renderHtml({
    reportCode: params.reportCode,
    reportTitle: meta.title,
    assignments,
    samples,
    actorsByID,
    abilityNames,
    sampleOffsets: opts.sampleOffsets,
    pullDeaths,
    deathHistogram,
  });
}
