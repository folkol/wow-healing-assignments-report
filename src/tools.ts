import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getConfig } from "./config.js";
import {
  fetchAllEvents,
  getReportMeta,
  listGuildReports,
  type Fight,
} from "./wcl/client.js";
import { analyzeCounterfactualAvoidance } from "./analysis/counterfactual.js";
import { analyzeDeathWindow } from "./analysis/deathWindow.js";
import { analyzePlayerDefensives } from "./analysis/defensives.js";
import { buildDeathMapTimeline } from "./analysis/timeline.js";
import { wclReportUrl } from "./util/links.js";
import { resolveDayExpression } from "./util/time.js";

function jsonContent(value: unknown) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function resolveGuild(opts: {
  guildName?: string;
  guildRegion?: string;
  guildRealm?: string;
}) {
  const cfg = getConfig();
  const name = opts.guildName ?? cfg.guildName;
  const region = opts.guildRegion ?? cfg.guildRegion;
  const realm = opts.guildRealm ?? cfg.guildRealm;
  if (!name || !region || !realm) {
    throw new Error(
      "Guild not set. Pass guildName/guildRegion/guildRealm or set WCL_GUILD_NAME/WCL_GUILD_REGION/WCL_GUILD_REALM.",
    );
  }
  return { name, region, realm };
}

function findFight(fights: Fight[], opts: {
  fightID?: number;
  encounterID?: number;
  encounterName?: string;
  attemptIndex?: number;
}): Fight | undefined {
  if (opts.fightID != null) return fights.find((f) => f.id === opts.fightID);

  const matchesEncounter = (f: Fight) => {
    if (opts.encounterID != null) return f.encounterID === opts.encounterID;
    if (opts.encounterName) {
      const n = opts.encounterName.toLowerCase();
      return f.name.toLowerCase().includes(n);
    }
    return false;
  };

  if (opts.attemptIndex == null) return undefined;
  let count = 0;
  for (const f of fights) {
    if (!matchesEncounter(f)) continue;
    count += 1;
    if (count === opts.attemptIndex) return f;
  }
  return undefined;
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "wcl_resolve_guild",
    {
      title: "Resolve configured guild",
      description:
        "Returns the currently configured guild (name/region/realm) used when other tools are called without explicit guild arguments.",
      inputSchema: {},
    },
    async () => {
      const cfg = getConfig();
      return jsonContent({
        guildName: cfg.guildName ?? null,
        guildRegion: cfg.guildRegion ?? null,
        guildRealm: cfg.guildRealm ?? null,
        timezone: cfg.timezone,
      });
    },
  );

  server.registerTool(
    "wcl_list_reports",
    {
      title: "List guild reports in a date range",
      description:
        'Lists Warcraft Logs reports for a guild. Provide either a natural-language day (e.g. "last monday"), an ISO date (YYYY-MM-DD), or explicit startMs/endMs. Returns report codes, titles, and zones.',
      inputSchema: {
        guildName: z.string().optional(),
        guildRegion: z.string().optional(),
        guildRealm: z.string().optional(),
        day: z
          .string()
          .optional()
          .describe('e.g. "last monday", "yesterday", "today", or "2026-04-13"'),
        startMs: z.number().int().optional(),
        endMs: z.number().int().optional(),
        limit: z.number().int().min(1).max(25).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async (args) => {
      const cfg = getConfig();
      const guild = resolveGuild(args);
      let startMs = args.startMs;
      let endMs = args.endMs;
      let label: string | null = null;
      if (args.day && (startMs == null || endMs == null)) {
        const resolved = resolveDayExpression(args.day, cfg.timezone);
        if (!resolved) throw new Error(`Could not parse day expression: ${args.day}`);
        startMs = resolved.startMs;
        endMs = resolved.endMs;
        label = resolved.label;
      }

      const res = await listGuildReports({
        guildName: guild.name,
        serverSlug: guild.realm,
        serverRegion: guild.region,
        startTime: startMs,
        endTime: endMs,
        limit: args.limit,
        page: args.page,
      });

      return jsonContent({
        guild,
        day: label,
        startMs,
        endMs,
        total: res.total,
        page: res.page,
        hasMore: res.hasMore,
        reports: res.reports.map((r) => ({
          code: r.code,
          title: r.title,
          startTime: r.startTime,
          endTime: r.endTime,
          zone: r.zone,
          url: `https://www.warcraftlogs.com/reports/${r.code}`,
        })),
      });
    },
  );

  server.registerTool(
    "wcl_report_fights",
    {
      title: "List fights in a report",
      description:
        "Returns fights (pulls) from a Warcraft Logs report. Optionally filter by encounter name/id and kill status. Every fight includes an attemptIndex scoped to that encounter (so you can say \"pull #32 on Salhadaar\").",
      inputSchema: {
        reportCode: z.string(),
        encounterID: z.number().int().optional(),
        encounterName: z.string().optional(),
        onlyKills: z.boolean().optional(),
      },
    },
    async (args) => {
      const meta = await getReportMeta(args.reportCode);
      const filtered = meta.fights.filter((f) => {
        if (args.onlyKills && !f.kill) return false;
        if (args.encounterID != null && f.encounterID !== args.encounterID) return false;
        if (args.encounterName) {
          if (!f.name.toLowerCase().includes(args.encounterName.toLowerCase())) return false;
        }
        return true;
      });
      // Compute encounter-scoped attemptIndex over the full fight list to keep numbering consistent.
      const attemptIndexByFightID = new Map<number, number>();
      const counts = new Map<number, number>();
      for (const f of meta.fights) {
        const n = (counts.get(f.encounterID) ?? 0) + 1;
        counts.set(f.encounterID, n);
        attemptIndexByFightID.set(f.id, n);
      }
      return jsonContent({
        code: meta.code,
        title: meta.title,
        zone: meta.zone,
        fights: filtered.map((f) => ({
          fightID: f.id,
          name: f.name,
          encounterID: f.encounterID,
          difficulty: f.difficulty,
          kill: f.kill,
          startTime: f.startTime,
          endTime: f.endTime,
          durationMs: f.endTime - f.startTime,
          fightPercentage: f.fightPercentage,
          bossPercentage: f.bossPercentage,
          attemptIndex: attemptIndexByFightID.get(f.id) ?? 0,
          url: wclReportUrl({ code: meta.code, fightID: f.id }),
        })),
      });
    },
  );

  server.registerTool(
    "wcl_events",
    {
      title: "Fetch raw events from a report",
      description:
        "Low-level event fetcher. Use for custom queries when higher-level analysis tools are not enough. Paginates internally up to maxEvents.",
      inputSchema: {
        reportCode: z.string(),
        fightIDs: z.array(z.number().int()).optional(),
        startMs: z.number().int().optional(),
        endMs: z.number().int().optional(),
        dataType: z
          .enum([
            "All",
            "Buffs",
            "Casts",
            "CombatantInfo",
            "DamageDone",
            "DamageTaken",
            "Deaths",
            "Debuffs",
            "Dispels",
            "Healing",
            "Interrupts",
            "Resources",
            "Summons",
            "Threat",
          ])
          .optional(),
        hostilityType: z.enum(["Friendlies", "Enemies"]).optional(),
        sourceID: z.number().int().optional(),
        targetID: z.number().int().optional(),
        abilityID: z.number().optional(),
        filterExpression: z.string().optional(),
        includeResources: z.boolean().optional(),
        maxEvents: z.number().int().min(1).max(50_000).optional(),
      },
    },
    async (args) => {
      const meta = await getReportMeta(args.reportCode);
      const startTime = args.startMs ?? meta.startTime;
      const endTime = args.endMs ?? meta.endTime;
      const events = await fetchAllEvents({
        code: args.reportCode,
        startTime,
        endTime,
        fightIDs: args.fightIDs,
        dataType: args.dataType,
        hostilityType: args.hostilityType,
        sourceID: args.sourceID,
        targetID: args.targetID,
        abilityID: args.abilityID,
        filterExpression: args.filterExpression,
        includeResources: args.includeResources,
        maxEvents: args.maxEvents,
      });
      return jsonContent({
        code: meta.code,
        startTime,
        endTime,
        count: events.length,
        events,
      });
    },
  );

  server.registerTool(
    "wcl_analyze_death_window",
    {
      title: "Analyze what killed people (beyond the killing blow)",
      description:
        'For each friendly death in the selected fights, aggregates damage taken in the N seconds before death. Returns per-death detail plus global rankings like "4/5 players took Aftershock seconds before dying".',
      inputSchema: {
        reportCode: z.string(),
        fightIDs: z.array(z.number().int()).optional(),
        encounterID: z.number().int().optional(),
        encounterName: z.string().optional(),
        onlyKills: z.boolean().optional(),
        windowSeconds: z.number().min(0.5).max(30).optional(),
      },
    },
    async (args) => {
      const meta = await getReportMeta(args.reportCode);
      let fightIDs = args.fightIDs;
      if (!fightIDs) {
        const selected = meta.fights.filter((f) => {
          if (args.onlyKills && !f.kill) return false;
          if (args.encounterID != null && f.encounterID !== args.encounterID) return false;
          if (args.encounterName) {
            if (!f.name.toLowerCase().includes(args.encounterName.toLowerCase())) return false;
          }
          return true;
        });
        fightIDs = selected.map((f) => f.id);
      }
      const windowMs = Math.round(((args.windowSeconds ?? 6) * 1000));
      const report = await analyzeDeathWindow({
        code: args.reportCode,
        fights: meta.fights,
        actors: meta.actors,
        abilities: meta.abilities,
        fightIDs,
        windowMs,
      });
      return jsonContent({
        reportCode: args.reportCode,
        reportUrl: `https://www.warcraftlogs.com/reports/${args.reportCode}`,
        selectedFights: fightIDs,
        ...report,
      });
    },
  );

  server.registerTool(
    "wcl_player_defensives_at_time",
    {
      title: "Heuristic defensive CD availability at time of death",
      description:
        "Given a player's death (identified by reportCode + fightID + playerName or playerID), reports which tracked defensive cooldowns were likely available based on last-cast + nominal CD. This is a heuristic (no charges / no haste-adjusted CD).",
      inputSchema: {
        reportCode: z.string(),
        fightID: z.number().int().optional(),
        encounterName: z.string().optional(),
        encounterID: z.number().int().optional(),
        attemptIndex: z.number().int().optional(),
        playerName: z.string().optional(),
        playerID: z.number().int().optional(),
        deathTimestamp: z
          .number()
          .int()
          .optional()
          .describe(
            "If omitted, uses the player's first death in the selected fight.",
          ),
      },
    },
    async (args) => {
      const meta = await getReportMeta(args.reportCode);
      const fight = findFight(meta.fights, args);
      if (!fight) {
        throw new Error(
          "Fight not found. Specify fightID or (encounterID/encounterName + attemptIndex).",
        );
      }
      const actor = args.playerID != null
        ? meta.actors.find((a) => a.id === args.playerID)
        : args.playerName
          ? meta.actors.find(
              (a) => a.name.toLowerCase() === args.playerName!.toLowerCase(),
            )
          : undefined;
      if (!actor) throw new Error("Player not found in report. Pass playerID or exact playerName.");

      let deathTs = args.deathTimestamp;
      if (deathTs == null) {
        const deathEvents = await fetchAllEvents({
          code: args.reportCode,
          startTime: fight.startTime,
          endTime: fight.endTime,
          fightIDs: [fight.id],
          dataType: "Deaths",
          hostilityType: "Friendlies",
          targetID: actor.id,
        });
        if (deathEvents.length === 0) {
          throw new Error(
            `${actor.name} did not die in fight ${fight.id}. Pass deathTimestamp manually if desired.`,
          );
        }
        deathTs = deathEvents[0].timestamp;
      }

      const report = await analyzePlayerDefensives({
        code: args.reportCode,
        fight,
        actors: meta.actors,
        playerID: actor.id,
        deathTimestamp: deathTs,
        reportStart: meta.startTime,
        reportEnd: meta.endTime,
      });
      return jsonContent({
        ...report,
        link: wclReportUrl({
          code: args.reportCode,
          fightID: fight.id,
          start: deathTs - fight.startTime - 10_000,
          end: deathTs - fight.startTime + 2_000,
          type: "deaths",
          targetID: actor.id,
        }),
      });
    },
  );

  server.registerTool(
    "wcl_counterfactual_ability_avoidance",
    {
      title: "How many deaths could have been avoided by not taking ability X",
      description:
        'Given a report + fight selection + ability name pattern (e.g. "Aftershock" or "shock"), counts how many friendly deaths had that ability hit them in the N seconds before death. Also classifies deaths that happened during a cluster of simultaneous deaths (assumed "called wipe") and reports counts excluding those. Upper-bound heuristic: "hit by" is not the same as "killed by".',
      inputSchema: {
        reportCode: z.string(),
        abilityPattern: z
          .string()
          .describe(
            'Case-insensitive substring, e.g. "Aftershock" or "Primordial Power". Does not support regex metacharacters.',
          ),
        fightIDs: z.array(z.number().int()).optional(),
        encounterID: z.number().int().optional(),
        encounterName: z.string().optional(),
        onlyKills: z.boolean().optional(),
        windowSeconds: z.number().min(0.5).max(30).optional(),
        wipeMinDeaths: z
          .number()
          .int()
          .min(2)
          .max(25)
          .optional()
          .describe("Min simultaneous deaths to classify as called wipe. Default 5."),
        wipeWindowSeconds: z
          .number()
          .min(1)
          .max(60)
          .optional()
          .describe("Cluster window for the wipe rule. Default 10."),
        wipeLookbackSeconds: z
          .number()
          .min(1)
          .max(60)
          .optional()
          .describe("How far before the last death in a wipe cluster to also treat as wipe. Default 15."),
      },
    },
    async (args) => {
      const meta = await getReportMeta(args.reportCode);
      let fightIDs = args.fightIDs;
      if (!fightIDs) {
        const selected = meta.fights.filter((f) => {
          if (args.onlyKills && !f.kill) return false;
          if (args.encounterID != null && f.encounterID !== args.encounterID) return false;
          if (args.encounterName) {
            if (!f.name.toLowerCase().includes(args.encounterName.toLowerCase())) return false;
          }
          // Ignore encounterID=0 trash entries when the caller filtered by encounter name/id.
          if ((args.encounterID != null || args.encounterName) && f.encounterID === 0) return false;
          return true;
        });
        fightIDs = selected.map((f) => f.id);
      }
      if (fightIDs.length === 0) {
        return jsonContent({
          error: "No fights matched the selection.",
          reportCode: args.reportCode,
          selection: {
            encounterID: args.encounterID,
            encounterName: args.encounterName,
            onlyKills: args.onlyKills,
          },
        });
      }
      const windowMs = Math.round((args.windowSeconds ?? 6) * 1000);
      const wipeMinDeaths = args.wipeMinDeaths ?? 5;
      const wipeWindowMs = Math.round((args.wipeWindowSeconds ?? 10) * 1000);
      const wipeLookbackMs = Math.round((args.wipeLookbackSeconds ?? 15) * 1000);
      const report = await analyzeCounterfactualAvoidance({
        code: args.reportCode,
        fights: meta.fights,
        actors: meta.actors,
        abilities: meta.abilities,
        fightIDs,
        abilityPattern: args.abilityPattern,
        windowMs,
        wipeMinDeaths,
        wipeWindowMs,
        wipeLookbackMs,
      });
      return jsonContent({
        reportCode: args.reportCode,
        reportUrl: `https://www.warcraftlogs.com/reports/${args.reportCode}`,
        selectedFights: fightIDs,
        ...report,
      });
    },
  );

  server.registerTool(
    "wcl_death_map_timeline",
    {
      title: "Death map + timeline for an encounter",
      description:
        "For a given encounter in a report (by name or id), returns per-death timeline entries with x/y coordinates (when logged) and optional boss cast events to overlay as markers. Useful for maps of where people die and when.",
      inputSchema: {
        reportCode: z.string(),
        encounterID: z.number().int().optional(),
        encounterName: z.string().optional(),
        includeBossCasts: z.boolean().optional(),
        maxBossEvents: z.number().int().min(100).max(20_000).optional(),
      },
    },
    async (args) => {
      const meta = await getReportMeta(args.reportCode);
      const match = meta.fights.find((f) => {
        if (args.encounterID != null) return f.encounterID === args.encounterID;
        if (args.encounterName)
          return f.name.toLowerCase().includes(args.encounterName.toLowerCase());
        return false;
      });
      if (!match) throw new Error("No matching encounter in this report.");
      const report = await buildDeathMapTimeline({
        code: args.reportCode,
        fights: meta.fights,
        actors: meta.actors,
        abilities: meta.abilities,
        encounterID: match.encounterID,
        encounterName: match.name,
        includeBossCasts: args.includeBossCasts,
        maxBossEvents: args.maxBossEvents,
      });
      return jsonContent({
        reportCode: args.reportCode,
        reportUrl: `https://www.warcraftlogs.com/reports/${args.reportCode}`,
        ...report,
      });
    },
  );
}
