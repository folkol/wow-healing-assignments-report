import { listGuildReports } from "../dist/wcl/client.js";
import { getConfig } from "../dist/config.js";

const cfg = getConfig();
console.log(`[smoke-guild] using ${cfg.guildName} @ ${cfg.guildRegion}/${cfg.guildRealm}`);
const res = await listGuildReports({
  guildName: cfg.guildName,
  serverSlug: cfg.guildRealm,
  serverRegion: cfg.guildRegion,
  limit: 5,
});
console.log(`[smoke-guild] total=${res.total} page=${res.page} hasMore=${res.hasMore}`);
for (const r of res.reports) {
  const start = new Date(r.startTime).toISOString();
  console.log(`  - ${r.code} ${start} | ${r.zone?.name ?? "?"} | ${r.title}`);
}
