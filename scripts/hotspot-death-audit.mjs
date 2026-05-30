/**
 * Pre-wipe deaths in hotspot windows — 5s damage + defensives/pots audit.
 * Usage: node --import tsx scripts/hotspot-death-audit.mjs [reportCode]
 */
import { writeFileSync } from "node:fs";
import { getReportMeta, fetchAllEvents } from "../src/wcl/client.ts";
import { analyzePlayerDefensives } from "../src/analysis/defensives.ts";
import { analyzeDeathWindow } from "../src/analysis/deathWindow.ts";

const REPORT = process.argv[2] ?? "gTYPRBaKGVCf2Fbc";
const WINDOW_MS = 5000;
const WIPE_MIN = 5;
const WIPE_WINDOW_SEC = 10;

const HOTSPOT_WINDOWS = [
  { label: "0:15–0:20", start: 15, end: 20 },
  { label: "0:40–0:45", start: 40, end: 45 },
  { label: "1:00–1:05", start: 60, end: 65 },
  { label: "1:05–1:10", start: 65, end: 70 },
  { label: "1:35–1:40", start: 95, end: 100 },
  { label: "2:35–2:40", start: 155, end: 160 },
];

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function findWipeCallSec(deaths) {
  const sorted = [...deaths].sort((a, b) => a.tIntoFightMs - b.tIntoFightMs);
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].tIntoFightMs / 1000;
    const end = start + WIPE_WINDOW_SEC;
    let count = 0;
    for (const d of sorted) {
      const sec = d.tIntoFightMs / 1000;
      if (sec >= start && sec < end) count++;
    }
    if (count >= WIPE_MIN) return start;
  }
  return null;
}

function inHotspot(sec) {
  return HOTSPOT_WINDOWS.find((w) => sec >= w.start && sec < w.end)?.label ?? null;
}

function isPotOrConsumable(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return (
    n.includes("potion") ||
    n.includes("phial") ||
    n.includes("healthstone") ||
    n.includes("healing draught") ||
    n.includes("refreshing healing") ||
    n.includes(" algari ") ||
    n.includes("tempered potion")
  );
}

function summarizeDamage(window) {
  const byAbility = new Map();
  let total = 0;
  for (const hit of window) {
    if (hit.type !== "damage") continue;
    total += hit.amount;
    const name = hit.abilityName ?? `#${hit.abilityID}`;
    const cur = byAbility.get(name) ?? 0;
    byAbility.set(name, cur + hit.amount);
  }
  const top = [...byAbility.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, amt]) => `${name} ${Math.round(amt / 1000)}k`);
  return { total, top: top.join("; ") || "—" };
}

function fmtDefList(spells, mode) {
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

function abilityNameFromEvent(ev, abilityNames) {
  if (typeof ev.ability?.name === "string") return ev.ability.name;
  const id =
    typeof ev.abilityGameID === "number"
      ? ev.abilityGameID
      : typeof ev.ability?.guid === "number"
        ? ev.ability.guid
        : null;
  if (id != null && abilityNames.has(id)) return abilityNames.get(id);
  return id != null ? `#${id}` : null;
}

function fmtUsedDefensives(defReport, castsInWindow) {
  const trackedIds = new Set(defReport.matchedSpells.map((s) => s.abilityID));
  const parts = [];
  for (const m of defReport.matchedSpells) {
    if (m.lastCastBeforeDeathMs != null && m.lastCastBeforeDeathMs <= WINDOW_MS) {
      parts.push(`${m.abilityName} @ -${(m.lastCastBeforeDeathMs / 1000).toFixed(1)}s`);
    }
  }
  for (const c of castsInWindow) {
    if (!c.abilityID || !trackedIds.has(c.abilityID)) continue;
    if (parts.some((p) => p.startsWith(c.abilityName))) continue;
    parts.push(`${c.abilityName} @ -${(c.tBeforeDeathMs / 1000).toFixed(1)}s`);
  }
  return parts.length ? parts.join("; ") : "none";
}

function fmtUsedPots(castsInWindow) {
  const pots = castsInWindow.filter((c) => isPotOrConsumable(c.abilityName));
  return pots.length
    ? pots.map((x) => `${x.abilityName} @ -${(x.tBeforeDeathMs / 1000).toFixed(1)}s`).join("; ")
    : "none";
}

function fmtActiveBuffs(defReport) {
  const names = defReport.activeBuffsAtDeath.map((b) => b.abilityName).filter(Boolean);
  return names.length ? names.join(", ") : "—";
}

const meta = await getReportMeta(REPORT);
const abilityNames = new Map((meta.abilities ?? []).map((a) => [a.gameID, a.name]));
const crownFights = meta.fights.filter((f) => f.encounterID === 3181);
const fightByID = new Map(crownFights.map((f) => [f.id, f]));

const attemptIndexByFightID = new Map();
{
  const counter = new Map();
  for (const f of crownFights) {
    const n = (counter.get(f.name) ?? 0) + 1;
    counter.set(f.name, n);
    attemptIndexByFightID.set(f.id, n);
  }
}

const deathEvents = await fetchAllEvents({
  code: REPORT,
  startTime: Math.min(...crownFights.map((f) => f.startTime)),
  endTime: Math.max(...crownFights.map((f) => f.endTime)),
  fightIDs: crownFights.map((f) => f.id),
  dataType: "Deaths",
  hostilityType: "Friendlies",
});

const byPull = new Map();
for (const ev of deathEvents) {
  const fightID =
    typeof ev.fight === "number"
      ? ev.fight
      : crownFights.find((f) => ev.timestamp >= f.startTime && ev.timestamp <= f.endTime)?.id;
  if (fightID == null) continue;
  const attempt = attemptIndexByFightID.get(fightID) ?? 0;
  const actor = meta.actors.find((a) => a.id === ev.targetID);
  const row = {
    fightID,
    attempt,
    timestamp: ev.timestamp,
    tIntoFightMs: ev.timestamp - fightByID.get(fightID).startTime,
    targetID: ev.targetID,
    playerName: actor?.name ?? `#${ev.targetID}`,
    playerClass: actor?.subType ?? null,
  };
  const list = byPull.get(attempt) ?? [];
  list.push(row);
  byPull.set(attempt, list);
}

const candidates = [];
for (const [attempt, deaths] of byPull) {
  const wipeSec = findWipeCallSec(deaths);
  for (const d of deaths) {
    const sec = d.tIntoFightMs / 1000;
    if (wipeSec != null && sec >= wipeSec) continue;
    const window = inHotspot(sec);
    if (!window) continue;
    candidates.push({ ...d, window, wipeSec });
  }
}

console.error(`Analyzing ${candidates.length} pre-wipe hotspot deaths...`);

const deathWindowReport = await analyzeDeathWindow({
  code: REPORT,
  fights: crownFights,
  actors: meta.actors,
  abilities: meta.abilities,
  fightIDs: crownFights.map((f) => f.id),
  windowMs: WINDOW_MS,
});

const deathByKey = new Map(
  deathWindowReport.deaths.map((d) => [`${d.fightID}|${d.timestamp}|${d.targetID}`, d]),
);

// Preload casts per player
const castsByPlayer = new Map();
const uniquePlayers = [...new Set(candidates.map((c) => c.targetID))];
for (const pid of uniquePlayers) {
  castsByPlayer.set(
    pid,
    await fetchAllEvents({
      code: REPORT,
      startTime: 0,
      endTime: meta.endTime - meta.startTime,
      dataType: "Casts",
      hostilityType: "Friendlies",
      sourceID: pid,
    }),
  );
}

const rows = [];
for (const c of candidates.sort((a, b) => a.attempt - b.attempt || a.tIntoFightMs - b.tIntoFightMs)) {
  const key = `${c.fightID}|${c.timestamp}|${c.targetID}`;
  const dw = deathByKey.get(key);
  const fight = fightByID.get(c.fightID);
  const def = await analyzePlayerDefensives({
    code: REPORT,
    fight,
    actors: meta.actors,
    playerID: c.targetID,
    deathTimestamp: c.timestamp,
    reportStart: meta.startTime,
    reportEnd: meta.endTime,
    preloadedCasts: castsByPlayer.get(c.targetID),
  });

  const dmg = summarizeDamage(dw?.window ?? []);
  const castsInWindow = [];
  for (const cast of castsByPlayer.get(c.targetID) ?? []) {
    if (cast.timestamp > c.timestamp || cast.timestamp < c.timestamp - WINDOW_MS) continue;
    const aid =
      typeof cast.abilityGameID === "number"
        ? cast.abilityGameID
        : typeof cast.ability?.guid === "number"
          ? cast.ability.guid
          : null;
    const name = abilityNameFromEvent(cast, abilityNames);
    castsInWindow.push({
      abilityID: aid,
      abilityName: name,
      tBeforeDeathMs: c.timestamp - cast.timestamp,
    });
  }

  rows.push({
    pull: c.attempt,
    window: c.window,
    time: fmtTime(c.tIntoFightMs / 1000),
    player: c.playerName,
    class: c.playerClass ?? "—",
    killingBlow: dw?.killingAbilityName ?? "—",
    damage5s: `${Math.round(dmg.total / 1000)}k`,
    damageTop: dmg.top,
    defAvailable: fmtDefList(def.matchedSpells, "available"),
    defOnCD: fmtDefList(def.matchedSpells, "oncd"),
    defUsed5s: fmtUsedDefensives(def, castsInWindow),
    potsUsed5s: fmtUsedPots(castsInWindow),
    activeBuffs: fmtActiveBuffs(def),
  });
  process.stderr.write(".");
}

console.error("\nDone.");

const outPath = new URL("../examples/crown-hotspot-deaths-audit.json", import.meta.url);
writeFileSync(outPath, JSON.stringify({ report: REPORT, windowMs: WINDOW_MS, rows }, null, 2));
console.log(JSON.stringify({ report: REPORT, count: rows.length, outPath: outPath.pathname }, null, 2));
