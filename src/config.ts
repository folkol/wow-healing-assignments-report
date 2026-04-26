import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WclConfig {
  clientId: string;
  clientSecret: string;
  guildName?: string;
  guildRegion?: string;
  guildRealm?: string;
  timezone: string;
}

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
    // dist/config.js -> project root
    resolve(here, "..", ".env"),
    // dist/<subdir>/config.js -> project root
    resolve(here, "..", "..", ".env"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1];
      let value = m[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in out)) out[key] = value;
    }
    break;
  }
  return out;
}

let cached: WclConfig | null = null;

export function getConfig(): WclConfig {
  if (cached) return cached;
  const fromFile = readEnvFile();
  const pick = (k: string) => process.env[k] ?? fromFile[k] ?? "";
  const clientId = pick("WCL_CLIENT_ID");
  const clientSecret = pick("WCL_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      "WCL_CLIENT_ID and WCL_CLIENT_SECRET are required. Create a client at https://www.warcraftlogs.com/api/clients/ and set them in the environment or in a .env file.",
    );
  }
  cached = {
    clientId,
    clientSecret,
    guildName: pick("WCL_GUILD_NAME") || undefined,
    guildRegion: pick("WCL_GUILD_REGION") || undefined,
    guildRealm: pick("WCL_GUILD_REALM") || undefined,
    timezone: pick("WCL_TIMEZONE") || "UTC",
  };
  return cached;
}
