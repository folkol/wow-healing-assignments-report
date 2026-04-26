export interface WclLinkArgs {
  code: string;
  fightID?: number | "last";
  start?: number;
  end?: number;
  type?: "damage-done" | "damage-taken" | "healing" | "deaths" | "casts" | "summary";
  sourceID?: number;
  targetID?: number;
}

export function wclReportUrl(args: WclLinkArgs): string {
  const url = new URL(`https://www.warcraftlogs.com/reports/${args.code}`);
  if (args.fightID != null) url.searchParams.set("fight", String(args.fightID));
  if (args.type) url.searchParams.set("type", args.type);
  if (args.start != null) url.searchParams.set("start", String(Math.floor(args.start)));
  if (args.end != null) url.searchParams.set("end", String(Math.floor(args.end)));
  if (args.sourceID != null) url.searchParams.set("source", String(args.sourceID));
  if (args.targetID != null) url.searchParams.set("target", String(args.targetID));
  return url.toString();
}
