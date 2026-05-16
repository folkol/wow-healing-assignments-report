import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchAllEvents, getReportMeta, type Actor, type WclEvent } from "../wcl/client.js";

type DifficultyName = "LFR" | "Normal" | "Heroic" | "Mythic";

interface Args {
  report: string;
  assignments: string;
  out: string;
  encounterID?: number;
  difficulty?: number;
  hitWindowSec: number;
  actualWindowSec: number;
  sampleOffsets: number[];
  maxEvents: number;
  open: boolean;
  spellMap: Map<number, number>;
  playerMap: Map<string, string>;
}

interface PlanAssignment {
  index: number;
  timeSec: number;
  tag: string;
  actorID: number;
  originalSpellID: number;
  spellID: number;
  bossSpellID?: number;
  note?: string;
}

interface ScoredAssignment extends PlanAssignment {
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

const DEFAULT_SPELL_MAP = new Map<number, number>([
  // WowUtils may export Chi-Ji while WCL records the cast as Yu'lon for this talent choice.
  [325197, 322118],
]);

function usage(exitCode = 1): never {
  console.error(`Usage:
  npm run cooldown-audit -- --report <warcraftlogs-url-or-code> --assignments <wowutils-copy-cds.txt> [options]

Options:
  --out <file>                Output HTML file (default: cooldown-audit.html)
  --encounter <id>            Encounter ID override. Defaults to EncounterID from assignments.
  --difficulty <name|id>      Difficulty override. Defaults to Difficulty from assignments.
  --hit-window <seconds>      On-time cast window around assignment (default: 8)
  --actual-window <seconds>   Nearest cast search window (default: 60)
  --sample-offsets <list>     Health/debuff sample offsets, seconds (default: -10,-5,0,5,10)
  --spell-map <from=to,...>   Spell ID remaps. Default includes 325197=322118.
  --no-default-spell-map      Disable default spell remaps.
  --player-map <from=to,...>  Map assignment tags to WCL player names.
  --max-events <count>        Event cap per stream (default: 250000)
  --open                      Open the HTML report after generating it.
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    report: "",
    assignments: "",
    out: "cooldown-audit.html",
    hitWindowSec: 8,
    actualWindowSec: 60,
    sampleOffsets: [-10, -5, 0, 5, 10],
    maxEvents: 250_000,
    open: false,
    spellMap: new Map(DEFAULT_SPELL_MAP),
    playerMap: new Map(),
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = () => argv[++i] ?? usage();
    switch (key) {
      case "--report":
        args.report = next();
        break;
      case "--assignments":
        args.assignments = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--encounter":
        args.encounterID = Number.parseInt(next(), 10);
        break;
      case "--difficulty":
        args.difficulty = parseDifficulty(next());
        break;
      case "--hit-window":
        args.hitWindowSec = Number.parseFloat(next());
        break;
      case "--actual-window":
        args.actualWindowSec = Number.parseFloat(next());
        break;
      case "--sample-offsets":
        args.sampleOffsets = next()
          .split(",")
          .map((v) => Number.parseFloat(v.trim()))
          .filter((v) => Number.isFinite(v));
        break;
      case "--spell-map":
        mergeMap(args.spellMap, next(), true);
        break;
      case "--no-default-spell-map":
        args.spellMap.clear();
        break;
      case "--player-map":
        mergeMap(args.playerMap, next(), false);
        break;
      case "--max-events":
        args.maxEvents = Number.parseInt(next(), 10);
        break;
      case "--open":
        args.open = true;
        break;
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        console.error(`Unknown argument: ${key}`);
        usage();
    }
  }

  if (!args.report || !args.assignments) usage();
  return args;
}

function mergeMap<T extends number | string>(
  map: Map<T, T>,
  text: string,
  numeric: boolean,
): void {
  for (const part of text.split(",")) {
    const [from, to] = part.split("=").map((v) => v?.trim());
    if (!from || !to) continue;
    if (numeric) {
      map.set(Number(from) as T, Number(to) as T);
    } else {
      map.set(from as T, to as T);
    }
  }
}

function parseDifficulty(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isFinite(n)) return n;
  const normalized = value.toLowerCase();
  const map: Record<string, number> = {
    lfr: 1,
    normal: 3,
    heroic: 4,
    mythic: 5,
  };
  const out = map[normalized];
  if (!out) throw new Error(`Unknown difficulty: ${value}`);
  return out;
}

function extractReportCode(input: string): string {
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

function parseAssignmentsHeader(text: string): {
  encounterID?: number;
  difficulty?: number;
  name?: string;
} {
  const first = text.split(/\r?\n/).find((line) => line.trim());
  if (!first) return {};
  const fields = parseAssignmentFields(`${first};`);
  return {
    encounterID: fields.EncounterID ? Number.parseInt(fields.EncounterID, 10) : undefined,
    difficulty: fields.Difficulty ? parseDifficulty(fields.Difficulty as DifficultyName) : undefined,
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

function parsePlan(
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

function scoreAssignments(params: {
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

interface HealthSample {
  avgHp?: number;
  lowest: Array<{ actorID: number; hpPct: number }>;
  under50: number;
  dead: number;
  activeDebuffs: string;
  debuffChanges: string;
}

function buildDeathState(events: WclEvent[]): Map<number, Array<{ timestamp: number; actorID: number; kind: "death" | "res" }>> {
  const byFight = new Map<number, Array<{ timestamp: number; actorID: number; kind: "death" | "res" }>>();
  for (const event of events) {
    const fight = numberField(event, "fight");
    const actorID = event.type === "death" ? event.targetID : event.targetID;
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

function annotateDeaths(assignments: ScoredAssignment[], deathState: Map<number, Array<{ timestamp: number; actorID: number; kind: "death" | "res" }>>): void {
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
    assignment.assignedDeathSec = deathTs == null ? undefined : (deathTs - assignment.fightStart) / 1000;
  }
}

function buildHealthSamples(params: {
  assignments: ScoredAssignment[];
  healthEvents: WclEvent[];
  debuffEvents: WclEvent[];
  deathState: Map<number, Array<{ timestamp: number; actorID: number; kind: "death" | "res" }>>;
  playerIDs: Set<number>;
  actorNames: Map<number, string>;
  abilityNames: Map<number, string>;
  sampleOffsets: number[];
}): Map<string, HealthSample> {
  const samples = new Map<string, HealthSample>();
  const requestsByFight = new Map<number, Array<{ timestamp: number; assignmentIndex: number; offset: number }>>();
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
    if (numberField(event, "hitPoints") == null || numberField(event, "maxHitPoints") == null) continue;
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
      while (healthIndex < healthEvents.length && healthEvents[healthIndex].timestamp <= request.timestamp) {
        const event = healthEvents[healthIndex++];
        const targetID = event.targetID;
        const hp = numberField(event, "hitPoints");
        const maxHp = numberField(event, "maxHitPoints");
        if (targetID && hp != null && maxHp != null && maxHp > 0) {
          healthState.set(targetID, { hp, maxHp });
        }
      }
      while (deathIndex < deathEvents.length && deathEvents[deathIndex].timestamp <= request.timestamp) {
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
        values.length > 0 ? values.reduce((sum, value) => sum + value.hpPct, 0) / values.length : undefined;
      const lowest = [...values].sort((a, b) => a.hpPct - b.hpPct).slice(0, 5);
      const under50 = values.filter((value) => value.hpPct < 50).length;

      const activeDebuffs = activeDebuffSummary(debuffEvents, request.timestamp, params.abilityNames);
      const debuffChanges = debuffChangeSummary(
        debuffEvents,
        request.timestamp - 2500,
        request.timestamp + 2500,
        params.abilityNames,
      );

      samples.set(`${request.assignmentIndex}:${request.offset}`, {
        avgHp,
        lowest,
        under50,
        dead: [...deadState].filter((actorID) => params.playerIDs.has(actorID)).length,
        activeDebuffs,
        debuffChanges,
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
  for (const abilityID of active.values()) counts.set(abilityID, (counts.get(abilityID) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([abilityID, count]) => `${abilityNames.get(abilityID) ?? abilityID} x${count}`)
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
    const sign = type.startsWith("remove") ? "-" : type.startsWith("apply") || type.startsWith("refresh") ? "+" : "~";
    const key = `${sign}:${abilityID}`;
    const entry = counts.get(key) ?? { sign, abilityID, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((entry) => `${entry.sign}${abilityNames.get(entry.abilityID) ?? entry.abilityID} x${entry.count}`)
    .join("; ");
}

function renderHtml(params: {
  reportCode: string;
  reportTitle: string;
  assignments: ScoredAssignment[];
  samples: Map<string, HealthSample>;
  actorsByID: Map<number, Actor>;
  abilityNames: Map<number, string>;
  sampleOffsets: number[];
}): string {
  const counts = new Map<ScoredAssignment["status"], number>();
  for (const assignment of params.assignments) {
    counts.set(assignment.status, (counts.get(assignment.status) ?? 0) + 1);
  }

  const rows = params.assignments
    .map((assignment, index) => {
      const actor = params.actorsByID.get(assignment.actorID);
      const spellName = params.abilityNames.get(assignment.spellID) ?? assignment.spellID;
      const spell =
        assignment.originalSpellID === assignment.spellID
          ? `${spellName} (${assignment.spellID})`
          : `${spellName} (${assignment.originalSpellID} -> ${assignment.spellID})`;
      const actual = assignment.actualSec == null ? "none nearby" : fmtTime(assignment.actualSec);
      const delta = assignment.deltaSec == null ? "" : `${assignment.deltaSec >= 0 ? "+" : ""}${assignment.deltaSec.toFixed(1)}s`;
      const death = assignment.assignedDead ? `dead since ${fmtTime(assignment.assignedDeathSec)}` : "";
      return `<tr class="${statusClass(assignment.status)}">
  <td>${assignment.attempt}</td>
  <td>${fmtTime(assignment.timeSec)}</td>
  <td>${htmlEscape(actual)}</td>
  <td>${htmlEscape(delta)}</td>
  <td>${assignment.status}</td>
  <td>${htmlEscape(actor?.name ?? assignment.tag)}</td>
  <td>${htmlEscape(spell)}</td>
  <td>${htmlEscape(assignment.bossSpellID ?? "")}</td>
  <td>${htmlEscape(death)}</td>
  <td><details><summary>health/debuff timeline</summary>${renderSampleTable(
    index,
    params.samples,
    params.actorsByID,
    params.sampleOffsets,
  )}</details></td>
</tr>`;
    })
    .join("\n");

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
.inner { margin: 10px 0; font-size: 12px; background: #151515; }
.inner th { position: static; }
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
</div>
<table>
<thead><tr><th>Pull</th><th>Assigned</th><th>Actual</th><th>Delta</th><th>Status</th><th>Player</th><th>Spell</th><th>Boss Spell</th><th>Death Context</th><th>Timeline</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;
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
        .map((entry) => `${actorsByID.get(entry.actorID)?.name ?? entry.actorID} ${entry.hpPct.toFixed(0)}%`)
        .join(", ");
      return `<tr><td>${offset >= 0 ? "+" : ""}${offset}s</td><td>${sample.avgHp == null ? "" : `${sample.avgHp.toFixed(0)}%`}</td><td>${htmlEscape(lowest)}</td><td>${sample.under50}</td><td>${sample.dead}</td><td>${htmlEscape(sample.activeDebuffs || "none")}</td><td>${htmlEscape(sample.debuffChanges || "none")}</td></tr>`;
    })
    .join("");
  return `<table class="inner"><thead><tr><th>Rel</th><th>Avg HP</th><th>Lowest HP</th><th>&lt;50%</th><th>Dead</th><th>Active Debuffs</th><th>Debuff Changes (+/-2.5s)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function openFile(path: string): void {
  const url = pathToFileURL(path).href;
  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reportCode = extractReportCode(args.report);
  const assignmentText = readFileSync(resolve(args.assignments), "utf8");
  const header = parseAssignmentsHeader(assignmentText);
  const encounterID = args.encounterID ?? header.encounterID;
  const difficulty = args.difficulty ?? header.difficulty;
  if (!encounterID) throw new Error("Encounter ID is required, either in assignments or --encounter.");
  if (!difficulty) throw new Error("Difficulty is required, either in assignments or --difficulty.");

  console.error(`Fetching report metadata for ${reportCode}...`);
  const meta = await getReportMeta(reportCode);
  const selectedFights = meta.fights
    .filter((fight) => fight.encounterID === encounterID && fight.difficulty === difficulty)
    .map((fight, index) => ({ ...fight, attempt: index + 1 }));
  if (selectedFights.length === 0) {
    throw new Error(`No fights found for encounter ${encounterID}, difficulty ${difficulty}.`);
  }

  const plan = parsePlan(assignmentText, meta.actors, args.spellMap, args.playerMap);
  const spellIDs = [...new Set(plan.map((assignment) => assignment.spellID))].sort((a, b) => a - b);
  const startTime = Math.min(...selectedFights.map((fight) => fight.startTime));
  const endTime = Math.max(...selectedFights.map((fight) => fight.endTime));
  const fightIDs = selectedFights.map((fight) => fight.id);

  console.error(`Fetching assignment casts (${spellIDs.length} spell IDs)...`);
  const casts = await fetchAllEvents({
    code: reportCode,
    startTime,
    endTime,
    fightIDs,
    dataType: "Casts",
    hostilityType: "Friendlies",
    filterExpression: `ability.id in (${spellIDs.join(",")})`,
    maxEvents: args.maxEvents,
  });

  const assignments = scoreAssignments({
    plan,
    fights: selectedFights,
    casts,
    hitWindowSec: args.hitWindowSec,
    actualWindowSec: args.actualWindowSec,
  });

  console.error("Fetching deaths/resurrections...");
  const [deaths, resurrections] = await Promise.all([
    fetchAllEvents({
      code: reportCode,
      startTime,
      endTime,
      fightIDs,
      dataType: "Deaths",
      hostilityType: "Friendlies",
      maxEvents: args.maxEvents,
    }),
    fetchAllEvents({
      code: reportCode,
      startTime,
      endTime,
      fightIDs,
      dataType: "All",
      hostilityType: "Friendlies",
      filterExpression: 'type = "resurrect"',
      maxEvents: args.maxEvents,
    }),
  ]);
  const deathState = buildDeathState([...deaths, ...resurrections]);
  annotateDeaths(assignments, deathState);

  console.error("Fetching health and debuff streams...");
  const [damage, healing, debuffs] = await Promise.all([
    fetchAllEvents({
      code: reportCode,
      startTime,
      endTime,
      fightIDs,
      dataType: "DamageTaken",
      hostilityType: "Friendlies",
      includeResources: true,
      maxEvents: args.maxEvents,
    }),
    fetchAllEvents({
      code: reportCode,
      startTime,
      endTime,
      fightIDs,
      dataType: "Healing",
      hostilityType: "Friendlies",
      includeResources: true,
      maxEvents: args.maxEvents,
    }),
    fetchAllEvents({
      code: reportCode,
      startTime,
      endTime,
      fightIDs,
      dataType: "Debuffs",
      hostilityType: "Friendlies",
      maxEvents: args.maxEvents,
    }),
  ]);

  const actorsByID = new Map(meta.actors.map((actor) => [actor.id, actor]));
  const abilityNames = new Map(meta.abilities.map((ability) => [ability.gameID, ability.name]));
  const playerIDs = new Set(meta.actors.map((actor) => actor.id));
  const samples = buildHealthSamples({
    assignments,
    healthEvents: [...damage, ...healing],
    debuffEvents: debuffs,
    deathState,
    playerIDs,
    actorNames: new Map(meta.actors.map((actor) => [actor.id, actor.name])),
    abilityNames,
    sampleOffsets: args.sampleOffsets,
  });

  const outPath = resolve(args.out);
  writeFileSync(
    outPath,
    renderHtml({
      reportCode,
      reportTitle: meta.title,
      assignments,
      samples,
      actorsByID,
      abilityNames,
      sampleOffsets: args.sampleOffsets,
    }),
    "utf8",
  );

  console.log(`Wrote ${outPath}`);
  console.log(`Open: ${pathToFileURL(outPath).href}`);
  if (args.open) openFile(outPath);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
