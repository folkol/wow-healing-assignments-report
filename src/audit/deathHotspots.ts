import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchAllEvents, getReportMeta, type Fight, type WclEvent } from "../wcl/client.js";
import { analyzeDeathWindow, type DeathRecord } from "../analysis/deathWindow.js";
import { analyzePlayerDefensives, type DefensiveStatus } from "../analysis/defensives.js";
import { findWipeCallSec } from "../analysis/wipeFilter.js";
import {
  buildDeathHistogramBuckets,
  buildPullDeaths,
  extractReportCode,
  parseDifficulty,
  type DeathTimeBucket,
  type PullDeath,
} from "./generate.js";

// ---------------------------------------------------------------------------
// Encounter config
// ---------------------------------------------------------------------------

interface EncounterHotspot {
  encounterID: number;
  name: string;
  windows: Array<{ label: string; start: number; end: number; mechanic?: string }>;
}

function loadEncounterHotspots(): EncounterHotspot[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "data", "encounter-hotspots.json"),
    resolve(here, "..", "..", "src", "data", "encounter-hotspots.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as EncounterHotspot[];
    } catch {
      // try next
    }
  }
  return [];
}

const ENCOUNTER_HOTSPOTS = loadEncounterHotspots();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HotspotWindow {
  label: string;
  start: number;
  end: number;
  mechanic?: string;
}

export interface HotspotAuditRow {
  attempt: number;
  timeSec: number;
  playerName: string;
  playerClass: string | null;
  killingBlow: string | null;
  hotspotLabel: string;
  damage5s: string;
  damageTop: string;
  defAvailable: string;
  defOnCD: string;
  defUsed5s: string;
  potsUsed5s: string;
  activeBuffs: string;
}

export interface HotspotReportData {
  reportCode: string;
  reportTitle: string;
  encounterName: string;
  pulls: number;
  rawDeaths: number;
  prewipeDeaths: number;
  excludedDeaths: number;
  histogram5s: DeathTimeBucket[];
  histogram10s: DeathTimeBucket[];
  hotspotWindows: HotspotWindow[];
  /** Wipe call time per pull (null if no cluster detected). */
  wipeSecs: Map<number, number | null>;
  /** Pre-wipe deaths per pull. */
  pullDeaths: PullDeath[];
  /** Mapping of actorID -> name. */
  actorNames: Map<number, string>;
  /** Mapping of abilityID -> name. */
  abilityNames: Map<number, string>;
  /** Audit rows (only when includeAudit: true). */
  auditRows: HotspotAuditRow[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface DeathHotspotsOptions {
  reportCode: string;
  encounterID?: number;
  difficulty?: number;
  includeAudit?: boolean;
}

export async function generateDeathHotspotsHtml(opts: DeathHotspotsOptions): Promise<string> {
  const { includeAudit = true } = opts;

  const meta = await getReportMeta(opts.reportCode);
  const abilityNames = new Map(
    (meta.abilities ?? []).map((a) => [a.gameID, a.name]),
  );
  const actorNames = new Map(meta.actors.map((a) => [a.id, a.name]));

  // Resolve encounter
  const nonTrash = meta.fights.filter((f) => f.encounterID !== 0);
  let encounterID = opts.encounterID;
  let difficulty = opts.difficulty;

  if (!encounterID) {
    const counts = new Map<number, number>();
    for (const f of nonTrash) counts.set(f.encounterID, (counts.get(f.encounterID) ?? 0) + 1);
    encounterID = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!encounterID) throw new Error("No boss encounters found in this report.");
  }

  const candidateFights = nonTrash.filter((f) => f.encounterID === encounterID);
  if (!difficulty) {
    const dCounts = new Map<number, number>();
    for (const f of candidateFights) {
      const d = f.difficulty ?? 0;
      dCounts.set(d, (dCounts.get(d) ?? 0) + 1);
    }
    difficulty = [...dCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  }

  const selectedFights = candidateFights.filter(
    (f) => difficulty === 0 || f.difficulty === difficulty,
  );
  if (selectedFights.length === 0) {
    throw new Error(
      `No fights found for encounter ${encounterID}, difficulty ${difficulty}.`,
    );
  }

  // Assign sequential attempt indices within this encounter
  let attemptCounter = 0;
  const attemptByFightID = new Map<number, number>();
  for (const f of selectedFights) {
    attemptByFightID.set(f.id, ++attemptCounter);
  }
  const selectedWithAttempt = selectedFights.map((f) => ({
    ...f,
    attempt: attemptByFightID.get(f.id)!,
  }));

  const encounterName =
    ENCOUNTER_HOTSPOTS.find((e) => e.encounterID === encounterID)?.name ??
    selectedFights[0]?.name ??
    `Encounter ${encounterID}`;

  // Fetch deaths
  const startTime = Math.min(...selectedFights.map((f) => f.startTime));
  const endTime = Math.max(...selectedFights.map((f) => f.endTime));
  const fightIDs = selectedFights.map((f) => f.id);

  const raidPlayerIDs = new Set(
    meta.actors.filter((a) => a.type.toLowerCase() === "player").map((a) => a.id),
  );

  const rawDeathEvents = await fetchAllEvents({
    code: opts.reportCode,
    startTime,
    endTime,
    fightIDs,
    dataType: "Deaths",
    hostilityType: "Friendlies",
  });

  // Group deaths by pull, run wipe filter
  const rawDeaths = buildPullDeaths({
    deathEvents: rawDeathEvents,
    fights: selectedWithAttempt,
    playerIDs: raidPlayerIDs,
  });

  const fightByID = new Map(selectedWithAttempt.map((f) => [f.id, f]));

  const wipeSecs = new Map<number, number | null>();
  const prewipePullDeaths: PullDeath[] = [];

  const byAttempt = new Map<number, PullDeath[]>();
  // Seed all attempts (some pulls may have zero tracked deaths)
  for (const attempt of attemptByFightID.values()) byAttempt.set(attempt, []);
  for (const d of rawDeaths) {
    byAttempt.get(d.attempt)!.push(d);
  }

  for (const [attempt, deaths] of byAttempt) {
    const wipeSec = findWipeCallSec(deaths.map((d) => ({ tIntoFightMs: d.timeSec * 1000 })));
    wipeSecs.set(attempt, wipeSec);
    const kept = wipeSec == null ? deaths : deaths.filter((d) => d.timeSec < wipeSec);
    prewipePullDeaths.push(...kept);
  }

  const maxFightDurationSec = Math.max(
    ...selectedFights.map((f) => (f.endTime - f.startTime) / 1000),
  );

  const histogram5s = buildDeathHistogramBuckets(prewipePullDeaths, maxFightDurationSec, 5);
  const histogram10s = buildDeathHistogramBuckets(prewipePullDeaths, maxFightDurationSec, 10);

  // Resolve hotspot windows
  const configWindows = ENCOUNTER_HOTSPOTS.find((e) => e.encounterID === encounterID)?.windows;
  let hotspotWindows: HotspotWindow[];
  if (configWindows && configWindows.length > 0) {
    hotspotWindows = configWindows;
  } else {
    // Auto-detect from 5s histogram peaks
    const maxCount = Math.max(...histogram5s.map((b) => b.count), 1);
    const peakThreshold = Math.max(2, Math.ceil(maxCount * 0.45));
    hotspotWindows = histogram5s
      .filter((b) => b.count >= peakThreshold)
      .map((b) => ({
        label: `${fmtTime(b.startSec)}–${fmtTime(b.endSec)}`,
        start: b.startSec,
        end: b.endSec,
      }));
  }

  // Build audit rows if requested
  let auditRows: HotspotAuditRow[] = [];
  if (includeAudit && hotspotWindows.length > 0) {
    auditRows = await buildAuditRows({
      reportCode: opts.reportCode,
      selectedFights,
      fightByID,
      meta,
      abilityNames,
      prewipePullDeaths,
      hotspotWindows,
      wipeSecs,
      attemptByFightID,
    });
  }

  const data: HotspotReportData = {
    reportCode: opts.reportCode,
    reportTitle: meta.title,
    encounterName,
    pulls: selectedFights.length,
    rawDeaths: rawDeaths.length,
    prewipeDeaths: prewipePullDeaths.length,
    excludedDeaths: rawDeaths.length - prewipePullDeaths.length,
    histogram5s,
    histogram10s,
    hotspotWindows,
    wipeSecs,
    pullDeaths: prewipePullDeaths,
    actorNames,
    abilityNames,
    auditRows,
  };

  return renderDeathHotspotsHtml(data);
}

// ---------------------------------------------------------------------------
// Audit rows
// ---------------------------------------------------------------------------

async function buildAuditRows(args: {
  reportCode: string;
  selectedFights: Fight[];
  fightByID: Map<number, Fight & { attempt: number }>;
  meta: Awaited<ReturnType<typeof getReportMeta>>;
  abilityNames: Map<number, string>;
  prewipePullDeaths: PullDeath[];
  hotspotWindows: HotspotWindow[];
  wipeSecs: Map<number, number | null>;
  attemptByFightID: Map<number, number>;
}): Promise<HotspotAuditRow[]> {
  const WINDOW_MS = 5000;

  // Find hotspot candidates from pre-wipe deaths
  const candidates = args.prewipePullDeaths.filter((d) => {
    return args.hotspotWindows.some((w) => d.timeSec >= w.start && d.timeSec < w.end);
  });

  if (candidates.length === 0) return [];

  // Run analyzeDeathWindow for all fights at once (fetches deaths + damage internally)
  const dwReport = await analyzeDeathWindow({
    code: args.reportCode,
    fights: args.selectedFights,
    actors: args.meta.actors,
    abilities: args.meta.abilities,
    fightIDs: args.selectedFights.map((f) => f.id),
    windowMs: WINDOW_MS,
  });

  const deathByKey = new Map<string, DeathRecord>(
    dwReport.deaths.map((d) => [`${d.fightID}|${d.timestamp}|${d.targetID}`, d]),
  );

  // Preload casts per unique player across entire report
  const uniquePlayerIDs = [...new Set(candidates.map((c) => c.actorID))];
  const castsByPlayer = new Map<number, WclEvent[]>();
  await Promise.all(
    uniquePlayerIDs.map(async (pid) => {
      const casts = await fetchAllEvents({
        code: args.reportCode,
        startTime: 0,
        endTime: args.meta.endTime - args.meta.startTime,
        dataType: "Casts",
        hostilityType: "Friendlies",
        sourceID: pid,
      });
      castsByPlayer.set(pid, casts);
    }),
  );

  const rows: HotspotAuditRow[] = [];
  const sortedCandidates = [...candidates].sort(
    (a, b) => a.attempt - b.attempt || a.timeSec - b.timeSec,
  );

  for (const c of sortedCandidates) {
    const fight = args.fightByID.get(c.fightID);
    if (!fight) continue;

    const fightStart = fight.startTime;
    const deathTimestamp = fightStart + c.timeSec * 1000;

    // Match to analyzeDeathWindow record (timestamps may differ slightly; find closest)
    const possibleKeys = dwReport.deaths
      .filter(
        (d) => d.fightID === c.fightID && d.targetID === c.actorID,
      )
      .sort(
        (a, b) =>
          Math.abs(a.timestamp - deathTimestamp) - Math.abs(b.timestamp - deathTimestamp),
      );
    const dw = possibleKeys[0];

    const def = await analyzePlayerDefensives({
      code: args.reportCode,
      fight,
      actors: args.meta.actors,
      playerID: c.actorID,
      deathTimestamp,
      reportStart: args.meta.startTime,
      reportEnd: args.meta.endTime,
      preloadedCasts: castsByPlayer.get(c.actorID),
    });

    const castsInWindow = (castsByPlayer.get(c.actorID) ?? [])
      .filter((cast) => cast.timestamp <= deathTimestamp && cast.timestamp >= deathTimestamp - WINDOW_MS)
      .map((cast) => {
        const aid =
          typeof cast.abilityGameID === "number"
            ? cast.abilityGameID
            : typeof (cast.ability as { guid?: number })?.guid === "number"
              ? (cast.ability as { guid: number }).guid
              : null;
        const name = abilityNameFromEvent(cast, args.abilityNames);
        return { abilityID: aid, abilityName: name, tBeforeDeathMs: deathTimestamp - cast.timestamp };
      });

    const hotspotLabel =
      args.hotspotWindows.find((w) => c.timeSec >= w.start && c.timeSec < w.end)?.label ?? "?";

    rows.push({
      attempt: c.attempt,
      timeSec: c.timeSec,
      playerName: args.meta.actors.find((a) => a.id === c.actorID)?.name ?? `#${c.actorID}`,
      playerClass: args.meta.actors.find((a) => a.id === c.actorID)?.subType ?? null,
      killingBlow: dw?.killingAbilityName ?? (c.killingAbilityID ? args.abilityNames.get(c.killingAbilityID) ?? null : null),
      hotspotLabel,
      damage5s: fmtDamage(dw?.window ?? []),
      damageTop: fmtDamageTop(dw?.window ?? []),
      defAvailable: fmtDefList(def.matchedSpells, "available"),
      defOnCD: fmtDefList(def.matchedSpells, "oncd"),
      defUsed5s: fmtUsedDefensives(def.matchedSpells, castsInWindow, WINDOW_MS),
      potsUsed5s: fmtUsedPots(castsInWindow),
      activeBuffs: fmtActiveBuffs(def.activeBuffsAtDeath),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function abilityNameFromEvent(ev: WclEvent, abilityNames: Map<number, string>): string | null {
  if (typeof (ev.ability as { name?: string })?.name === "string") {
    return (ev.ability as { name: string }).name;
  }
  const id =
    typeof ev.abilityGameID === "number"
      ? ev.abilityGameID
      : typeof (ev.ability as { guid?: number })?.guid === "number"
        ? (ev.ability as { guid: number }).guid
        : null;
  if (id != null) return abilityNames.get(id) ?? `#${id}`;
  return null;
}

function fmtDamage(window: DeathRecord["window"]): string {
  let total = 0;
  for (const hit of window) {
    if (hit.type === "damage") total += hit.amount;
  }
  return `${Math.round(total / 1000)}k`;
}

function fmtDamageTop(window: DeathRecord["window"]): string {
  const byAbility = new Map<string, number>();
  for (const hit of window) {
    if (hit.type !== "damage") continue;
    const name = hit.abilityName ?? `#${hit.abilityID}`;
    byAbility.set(name, (byAbility.get(name) ?? 0) + hit.amount);
  }
  return [...byAbility.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, amt]) => `${name} ${Math.round(amt / 1000)}k`)
    .join("; ") || "—";
}

function fmtDefList(
  spells: DefensiveStatus[],
  mode: "available" | "oncd",
): string {
  const filtered = spells.filter((s) =>
    mode === "available" ? s.availableAtDeath : !s.availableAtDeath,
  );
  if (filtered.length === 0) return "—";
  return filtered
    .map((s) => {
      if (mode === "available") return s.abilityName;
      const sec = s.lastCastBeforeDeathMs != null ? (s.lastCastBeforeDeathMs / 1000).toFixed(0) : "?";
      return `${s.abilityName} (${sec}s ago)`;
    })
    .join(", ");
}

function fmtUsedDefensives(
  matchedSpells: DefensiveStatus[],
  castsInWindow: Array<{ abilityID: number | null; abilityName: string | null; tBeforeDeathMs: number }>,
  windowMs: number,
): string {
  const trackedIDs = new Set(matchedSpells.map((s) => s.abilityID));
  const parts: string[] = [];
  for (const m of matchedSpells) {
    if (m.lastCastBeforeDeathMs != null && m.lastCastBeforeDeathMs <= windowMs) {
      parts.push(`${m.abilityName} @ -${(m.lastCastBeforeDeathMs / 1000).toFixed(1)}s`);
    }
  }
  for (const c of castsInWindow) {
    if (!c.abilityID || !trackedIDs.has(c.abilityID)) continue;
    if (parts.some((p) => p.startsWith(c.abilityName ?? ""))) continue;
    parts.push(`${c.abilityName} @ -${(c.tBeforeDeathMs / 1000).toFixed(1)}s`);
  }
  return parts.length ? parts.join("; ") : "none";
}

function isPotOrConsumable(name: string | null): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return (
    n.includes("potion") ||
    n.includes("phial") ||
    n.includes("healthstone") ||
    n.includes("healing draught") ||
    n.includes("refreshing healing") ||
    n.includes(" algari ") ||
    n.includes("tempered potion") ||
    n.includes("silvermoon health")
  );
}

function fmtUsedPots(
  castsInWindow: Array<{ abilityName: string | null; tBeforeDeathMs: number }>,
): string {
  const pots = castsInWindow.filter((c) => isPotOrConsumable(c.abilityName));
  if (pots.length === 0) return "none";
  return pots.map((x) => `${x.abilityName} @ -${(x.tBeforeDeathMs / 1000).toFixed(1)}s`).join("; ");
}

function fmtActiveBuffs(
  activeBuffs: Array<{ abilityID: number | null; abilityName: string | null }>,
): string {
  const names = activeBuffs.map((b) => b.abilityName).filter(Boolean);
  return names.length ? names.join(", ") : "—";
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

function htmlEscape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderHistogram(
  buckets: DeathTimeBucket[],
  label: string,
  hotspotWindows: HotspotWindow[],
  bucketSec: number,
): string {
  if (buckets.length === 0) return "";
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const peakThreshold = Math.max(2, Math.ceil(maxCount * 0.45));
  const maxTimeSec = buckets.at(-1)?.endSec ?? 1;
  const barWidthPx = bucketSec <= 5 ? 7 : 10;
  const trackWidthPx = buckets.length * barWidthPx;

  const bands = hotspotWindows
    .map((w) => {
      const leftPx = (w.start / maxTimeSec) * trackWidthPx;
      const widthPx = ((w.end - w.start) / maxTimeSec) * trackWidthPx;
      return `<div class="hist-hotspot-band" style="left:${leftPx.toFixed(1)}px;width:${widthPx.toFixed(1)}px" title="${htmlEscape(w.label)}"></div>`;
    })
    .join("");

  const bars = buckets
    .map((b) => {
      const isHotspot = hotspotWindows.some(
        (w) => b.startSec < w.end && b.endSec > w.start,
      );
      const isPeak = b.count >= peakThreshold;
      const heightPct = b.count === 0 ? 0 : Math.max(6, (b.count / maxCount) * 100);
      const tip = `${fmtTime(b.startSec)}–${fmtTime(b.endSec)}: ${b.count} death${b.count === 1 ? "" : "s"}`;
      const cls = [
        "hist-bar",
        b.count === 0 ? "empty" : "",
        isPeak ? "peak" : "",
        isHotspot ? "hotspot" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<div class="${cls}" style="width:${barWidthPx}px;height:${heightPct}%" title="${htmlEscape(tip)}"></div>`;
    })
    .join("");

  const tickIntervalSec = maxTimeSec > 300 ? 60 : maxTimeSec > 120 ? 30 : 15;
  const axisTicks: string[] = [];
  for (let t = 0; t <= maxTimeSec; t += tickIntervalSec) {
    const leftPx = (t / maxTimeSec) * trackWidthPx;
    axisTicks.push(
      `<span class="hist-tick" style="left:${leftPx.toFixed(1)}px">${fmtTime(t)}</span>`,
    );
  }

  return `<div class="hist-section">
  <div class="hist-label">${htmlEscape(label)}</div>
  <div class="hist-scroll">
    <div class="hist-track-wrap" style="width:${trackWidthPx}px">
      <div class="hist-bands">${bands}</div>
      <div class="hist-track">${bars}</div>
      <div class="hist-axis">${axisTicks.join("")}</div>
    </div>
  </div>
</div>`;
}

function renderHotspotTable(
  hotspotWindows: HotspotWindow[],
  pullDeaths: PullDeath[],
  abilityNames: Map<number, string>,
  actorNames: Map<number, string>,
): string {
  if (hotspotWindows.length === 0) return "";

  const rows = hotspotWindows
    .map((w) => {
      const windowDeaths = pullDeaths.filter((d) => d.timeSec >= w.start && d.timeSec < w.end);
      const killerCounts = new Map<string, number>();
      for (const d of windowDeaths) {
        if (d.killingAbilityID) {
          const name = abilityNames.get(d.killingAbilityID) ?? `#${d.killingAbilityID}`;
          killerCounts.set(name, (killerCounts.get(name) ?? 0) + 1);
        }
      }
      const topKillers = [...killerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name} (${count})`)
        .join(", ");

      const playerCounts = new Map<string, number>();
      for (const d of windowDeaths) {
        const name = actorNames.get(d.actorID) ?? `#${d.actorID}`;
        playerCounts.set(name, (playerCounts.get(name) ?? 0) + 1);
      }
      const repeatOffenders = [...playerCounts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} ×${count}`)
        .join(", ");

      return `<tr>
  <td>${htmlEscape(w.label)}</td>
  <td>${htmlEscape(w.mechanic ?? "—")}</td>
  <td>${windowDeaths.length}</td>
  <td>${htmlEscape(topKillers || "—")}</td>
  <td>${htmlEscape(repeatOffenders || "—")}</td>
</tr>`;
    })
    .join("\n");

  return `<h2>Hotspot Windows</h2>
<table>
<thead><tr><th>Window</th><th>Mechanic</th><th>Deaths</th><th>Top Killing Blows</th><th>Repeat Offenders (≥2)</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function renderPullTimeline(
  pullDeaths: PullDeath[],
  wipeSecs: Map<number, number | null>,
  hotspotWindows: HotspotWindow[],
  actorNames: Map<number, string>,
  abilityNames: Map<number, string>,
  maxTimeSec: number,
): string {
  const allAttempts = [...new Set(pullDeaths.map((d) => d.attempt))];
  const wipeAttempts = [...wipeSecs.keys()];
  const attempts = [...new Set([...allAttempts, ...wipeAttempts])].sort((a, b) => a - b);

  if (attempts.length === 0) return "";

  const WIDTH = 600;
  const ROW_HEIGHT = 20;
  const LABEL_W = 50;
  const CHART_W = WIDTH - LABEL_W;
  const MAX_T = maxTimeSec;

  function xPct(sec: number): number {
    return (sec / MAX_T) * CHART_W;
  }

  const rows = attempts
    .map((attempt) => {
      const deaths = pullDeaths.filter((d) => d.attempt === attempt);
      const wipeSec = wipeSecs.get(attempt) ?? null;

      const dots = deaths
        .map((d) => {
          const x = LABEL_W + xPct(d.timeSec);
          const isHotspot = hotspotWindows.some((w) => d.timeSec >= w.start && d.timeSec < w.end);
          const playerName = actorNames.get(d.actorID) ?? `#${d.actorID}`;
          const killer = d.killingAbilityID ? (abilityNames.get(d.killingAbilityID) ?? "") : "";
          const tip = `P${attempt} ${fmtTime(d.timeSec)} – ${playerName}${killer ? ` (${killer})` : ""}`;
          const color = isHotspot ? "#f87171" : "#60a5fa";
          return `<circle cx="${x.toFixed(1)}" cy="10" r="4" fill="${color}" opacity="0.9"><title>${htmlEscape(tip)}</title></circle>`;
        })
        .join("");

      const wipeTick = wipeSec != null
        ? `<line x1="${(LABEL_W + xPct(wipeSec)).toFixed(1)}" y1="2" x2="${(LABEL_W + xPct(wipeSec)).toFixed(1)}" y2="18" stroke="#fb923c" stroke-width="2" opacity="0.9"><title>Wipe call @ ${fmtTime(wipeSec)}</title></line>`
        : "";

      const hotspotBands = hotspotWindows
        .map((w) => {
          const x1 = LABEL_W + xPct(w.start);
          const x2 = LABEL_W + xPct(w.end);
          return `<rect x="${x1.toFixed(1)}" y="0" width="${(x2 - x1).toFixed(1)}" height="${ROW_HEIGHT}" fill="#fbbf24" opacity="0.08"/>`;
        })
        .join("");

      return `<svg width="${WIDTH}" height="${ROW_HEIGHT}" style="display:block;overflow:visible">
  <text x="${LABEL_W - 4}" y="14" text-anchor="end" font-size="11" fill="#8898b8">P${attempt}</text>
  <line x1="${LABEL_W}" y1="10" x2="${WIDTH}" y2="10" stroke="#2e3352" stroke-width="1"/>
  ${hotspotBands}${wipeTick}${dots}
</svg>`;
    })
    .join("\n");

  const tickInterval = MAX_T > 300 ? 60 : 30;
  const axisTicks: string[] = [];
  for (let t = 0; t <= MAX_T; t += tickInterval) {
    const x = LABEL_W + xPct(t);
    axisTicks.push(
      `<text x="${x.toFixed(1)}" y="14" text-anchor="middle" font-size="10" fill="#8898b8">${fmtTime(t)}</text>`,
    );
  }

  const axisRow = `<svg width="${WIDTH}" height="18" style="display:block">${axisTicks.join("")}</svg>`;

  return `<h2>Per-Pull Timeline</h2>
<div class="meta">Red dots = hotspot-window deaths, blue = other pre-wipe deaths, orange bar = wipe call, yellow band = hotspot window.</div>
<div class="timeline-wrap">
${rows}
${axisRow}
</div>`;
}

function renderAuditTable(auditRows: HotspotAuditRow[]): string {
  if (auditRows.length === 0) return "";

  // Group by hotspot window
  const byWindow = new Map<string, HotspotAuditRow[]>();
  for (const row of auditRows) {
    const list = byWindow.get(row.hotspotLabel) ?? [];
    list.push(row);
    byWindow.set(row.hotspotLabel, list);
  }

  const sections = [...byWindow.entries()]
    .map(([label, rows]) => {
      const tableRows = rows
        .map(
          (r) => `<tr>
  <td>P${r.attempt}</td>
  <td>${fmtTime(r.timeSec)}</td>
  <td>${htmlEscape(r.playerName)}</td>
  <td>${htmlEscape(r.playerClass ?? "—")}</td>
  <td>${htmlEscape(r.killingBlow ?? "—")}</td>
  <td>${htmlEscape(r.damage5s)}</td>
  <td class="small">${htmlEscape(r.damageTop)}</td>
  <td class="small">${htmlEscape(r.defAvailable)}</td>
  <td class="small">${htmlEscape(r.defOnCD)}</td>
  <td class="small">${htmlEscape(r.defUsed5s)}</td>
  <td class="small">${htmlEscape(r.potsUsed5s)}</td>
  <td class="small">${htmlEscape(r.activeBuffs)}</td>
</tr>`,
        )
        .join("\n");

      return `<h3>${htmlEscape(label)}</h3>
<table class="audit">
<thead><tr>
  <th>Pull</th><th>Time</th><th>Player</th><th>Class</th><th>Killing Blow</th>
  <th>Dmg 5s</th><th>Top Sources</th><th>Def Available</th><th>Def on CD</th>
  <th>Def Used (5s)</th><th>Pots (5s)</th><th>Active Buffs</th>
</tr></thead>
<tbody>${tableRows}</tbody>
</table>`;
    })
    .join("\n");

  return `<h2>Death Audit by Window</h2>
<div class="meta">Per-death breakdown for hotspot-window deaths only. "Def Used (5s)" = tracked defensives pressed in the 5s before death.</div>
${sections}`;
}

export function renderDeathHotspotsHtml(data: HotspotReportData): string {
  const maxTimeSec = Math.max(
    ...data.pullDeaths.map((d) => d.timeSec),
    ...[...data.wipeSecs.values()].filter((v): v is number => v != null),
    60,
  );

  const histograms = [
    renderHistogram(data.histogram5s, "Deaths by 5s window", data.hotspotWindows, 5),
    renderHistogram(data.histogram10s, "Deaths by 10s window", data.hotspotWindows, 10),
  ].join("\n");

  const hotspotTable = renderHotspotTable(
    data.hotspotWindows,
    data.pullDeaths,
    data.abilityNames,
    data.actorNames,
  );

  const pullTimeline = renderPullTimeline(
    data.pullDeaths,
    data.wipeSecs,
    data.hotspotWindows,
    data.actorNames,
    data.abilityNames,
    maxTimeSec,
  );

  const auditSection = renderAuditTable(data.auditRows);

  const difficultlyLabel: Record<number, string> = { 1: "LFR", 3: "Normal", 4: "Heroic", 5: "Mythic" };
  const diffLabel = difficultlyLabel[
    [...data.wipeSecs.keys()].length > 0 ? 0 : 0
  ] ?? "";
  void diffLabel;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Death Hotspots – ${htmlEscape(data.encounterName)}</title>
<style>
:root { color-scheme: dark; }
body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 24px; background: #111; color: #eee; max-width: 1100px; }
h1 { margin-bottom: 0; }
h2 { margin: 28px 0 10px; font-size: 1.1rem; color: #c8d4ff; }
h3 { margin: 20px 0 6px; font-size: 0.95rem; color: #aabbee; }
.meta { color: #8898b8; margin: 6px 0 14px; font-size: 0.85rem; }
.summary { display: flex; gap: 14px; flex-wrap: wrap; margin: 18px 0; }
.card { border: 1px solid #333; border-radius: 8px; padding: 10px 16px; background: #181818; }
.card b { font-size: 22px; display: block; }
table { border-collapse: collapse; width: 100%; font-size: 12px; margin-bottom: 20px; }
table.audit { font-size: 11px; }
th, td { border-bottom: 1px solid #2a2a2a; padding: 6px 8px; vertical-align: top; text-align: left; }
th { position: sticky; top: 0; background: #1c1c1c; z-index: 1; }
td.small { font-size: 10px; color: #b0bcd8; max-width: 160px; }
.hist-section { margin: 12px 0; }
.hist-label { font-size: 11px; color: #8898b8; margin-bottom: 4px; }
.hist-scroll { overflow-x: auto; padding-bottom: 4px; }
.hist-track-wrap { position: relative; min-width: 100%; }
.hist-bands { position: absolute; inset: 0 0 18px 0; pointer-events: none; }
.hist-hotspot-band { position: absolute; top: 0; bottom: 0; background: rgba(251, 191, 36, 0.12); border-left: 1px solid rgba(251, 191, 36, 0.25); border-right: 1px solid rgba(251, 191, 36, 0.25); }
.hist-track { display: flex; align-items: flex-end; gap: 1px; height: 80px; border-bottom: 1px solid #2e3352; position: relative; z-index: 1; }
.hist-bar { flex: 0 0 auto; min-width: 2px; background: linear-gradient(to top, #1a5a5a, #38b0b0); border-radius: 2px 2px 0 0; cursor: default; }
.hist-bar.peak { background: linear-gradient(to top, #22a0a0, #5ee0e0); box-shadow: 0 0 8px rgba(64,224,224,0.3); }
.hist-bar.hotspot { background: linear-gradient(to top, #7c1a1a, #f87171); }
.hist-bar.peak.hotspot { background: linear-gradient(to top, #a02020, #f87171); box-shadow: 0 0 8px rgba(248,113,113,0.4); }
.hist-bar.empty { background: #1a1a1a; min-height: 0; }
.hist-axis { position: relative; height: 16px; margin-top: 4px; }
.hist-tick { position: absolute; transform: translateX(-50%); font-size: 10px; color: #666; white-space: nowrap; }
.timeline-wrap { overflow-x: auto; }
</style>
</head>
<body>
<h1>Death Hotspots</h1>
<div class="meta">
  ${htmlEscape(data.reportTitle)} — ${htmlEscape(data.encounterName)} &middot;
  <a href="https://www.warcraftlogs.com/reports/${htmlEscape(data.reportCode)}" style="color:#9ecbff">View on WCL</a>
</div>

<div class="summary">
  <div class="card"><b>${data.pulls}</b>Pulls</div>
  <div class="card"><b>${data.rawDeaths}</b>Raw deaths</div>
  <div class="card"><b>${data.prewipeDeaths}</b>Pre-wipe deaths</div>
  <div class="card"><b>${data.excludedDeaths}</b>Excluded (wipe cascade)</div>
  <div class="card"><b>${data.hotspotWindows.length}</b>Hotspot windows</div>
</div>

<h2>Death Histograms</h2>
<div class="meta">Pre-wipe deaths only. Hover bars for exact 5s/10s ranges. Red bars = hotspot windows; yellow bands mark configured hotspot windows; bright/glowing = peak bucket (&ge;45% of max).</div>
${histograms}

${hotspotTable}

${pullTimeline}

${auditSection}
</body>
</html>`;
}

// Re-export utilities for CLI and API use
export { extractReportCode, parseDifficulty };
