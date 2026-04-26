import { gql } from "./graphql.js";
import { Q_GUILD_REPORTS, Q_REPORT_EVENTS, Q_REPORT_META } from "./queries.js";

export interface ReportSummary {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
  zone: { id: number; name: string } | null;
  owner: { name: string } | null;
}

export interface Fight {
  id: number;
  name: string;
  encounterID: number;
  difficulty: number | null;
  kill: boolean | null;
  startTime: number;
  endTime: number;
  fightPercentage: number | null;
  bossPercentage: number | null;
  lastPhase: number | null;
  lastPhaseAsAbsoluteIndex: number | null;
  size: number | null;
  averageItemLevel: number | null;
}

export interface Actor {
  id: number;
  name: string;
  type: string;
  subType: string;
  server: string | null;
}

export interface Ability {
  gameID: number;
  name: string;
  icon: string | null;
  type: number | null;
}

export interface ReportMeta {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
  zone: { id: number; name: string } | null;
  fights: Fight[];
  actors: Actor[];
  abilities: Ability[];
}

export interface WclEvent {
  type?: string;
  timestamp: number;
  sourceID?: number;
  targetID?: number;
  abilityGameID?: number;
  ability?: { name?: string; guid?: number };
  amount?: number;
  unmitigatedAmount?: number;
  overkill?: number;
  hitType?: number;
  x?: number;
  y?: number;
  mapID?: number;
  killerID?: number;
  killingAbilityGameID?: number;
  // dataType-specific fields will come through as well
  [key: string]: unknown;
}

export async function listGuildReports(params: {
  guildName: string;
  serverSlug: string;
  serverRegion: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  page?: number;
}): Promise<{
  total: number;
  hasMore: boolean;
  page: number;
  reports: ReportSummary[];
}> {
  const data = await gql<{
    reportData: {
      reports: {
        total: number;
        current_page: number;
        has_more_pages: boolean;
        data: ReportSummary[];
      };
    };
  }>(Q_GUILD_REPORTS, {
    name: params.guildName,
    serverSlug: params.serverSlug,
    serverRegion: params.serverRegion,
    startTime: params.startTime,
    endTime: params.endTime,
    limit: params.limit ?? 25,
    page: params.page ?? 1,
  });
  const r = data.reportData.reports;
  return {
    total: r.total,
    hasMore: r.has_more_pages,
    page: r.current_page,
    reports: r.data,
  };
}

export async function getReportMeta(code: string): Promise<ReportMeta> {
  const data = await gql<{
    reportData: {
      report: {
        code: string;
        title: string;
        startTime: number;
        endTime: number;
        zone: { id: number; name: string } | null;
        fights: Fight[];
        masterData: { actors: Actor[]; abilities: Ability[] };
      } | null;
    };
  }>(Q_REPORT_META, { code });
  const report = data.reportData.report;
  if (!report) throw new Error(`Report not found: ${code}`);
  return {
    code: report.code,
    title: report.title,
    startTime: report.startTime,
    endTime: report.endTime,
    zone: report.zone,
    fights: report.fights,
    actors: report.masterData.actors,
    abilities: report.masterData.abilities ?? [],
  };
}

export interface FetchEventsArgs {
  code: string;
  startTime: number;
  endTime: number;
  fightIDs?: number[];
  dataType?:
    | "All"
    | "Buffs"
    | "Casts"
    | "CombatantInfo"
    | "DamageDone"
    | "DamageTaken"
    | "Deaths"
    | "Debuffs"
    | "Dispels"
    | "Healing"
    | "Interrupts"
    | "Resources"
    | "Summons"
    | "Threat";
  hostilityType?: "Friendlies" | "Enemies";
  sourceID?: number;
  targetID?: number;
  abilityID?: number;
  filterExpression?: string;
  includeResources?: boolean;
  pageLimit?: number;
  maxEvents?: number;
}

export async function fetchAllEvents(args: FetchEventsArgs): Promise<WclEvent[]> {
  const out: WclEvent[] = [];
  let cursor: number = args.startTime;
  const cap = args.maxEvents ?? 50_000;
  const perPage = args.pageLimit ?? 10_000;

  while (cursor < args.endTime && out.length < cap) {
    const data = await gql<{
      reportData: {
        report: {
          events: { data: WclEvent[]; nextPageTimestamp: number | null };
        };
      };
    }>(Q_REPORT_EVENTS, {
      code: args.code,
      startTime: cursor,
      endTime: args.endTime,
      fightIDs: args.fightIDs,
      dataType: args.dataType,
      hostilityType: args.hostilityType,
      sourceID: args.sourceID,
      targetID: args.targetID,
      abilityID: args.abilityID,
      filterExpression: args.filterExpression,
      includeResources: args.includeResources,
      limit: perPage,
    });
    const ev = data.reportData.report.events;
    if (Array.isArray(ev.data)) out.push(...ev.data);
    if (ev.nextPageTimestamp == null || ev.nextPageTimestamp <= cursor) break;
    cursor = ev.nextPageTimestamp;
  }
  return out;
}
