# ancient-circle-wcl-mcp

An MCP server that analyzes [Warcraft Logs](https://www.warcraftlogs.com) reports for the **Ancient Circle** guild (EU - Tarren Mill). It exposes small tools for listing guild reports and fights, plus higher-level analyses that go beyond "the killing blow" — damage windows before death, heuristic defensive-CD availability, and a death map / boss-event timeline for an encounter.

## What it can answer

- How people actually died on a fight (e.g. "4 out of 5 deaths took Aftershock in the last 3 seconds").
- Which defensives a specific player had available when they died on a given pull.
- Where deaths cluster on an encounter, with boss casts overlaid as markers.

Every tool returns structured JSON the model can reason over plus a Warcraft Logs deep link you can open in the browser.

## Setup

1. Install Node.js 20+.
2. Create a Warcraft Logs API client at [warcraftlogs.com/api/clients](https://www.warcraftlogs.com/api/clients/) and copy the client id and secret.
3. From the project directory:

```powershell
npm install
npm run build
```

4. Copy `.env.example` to `.env` and fill in your credentials and default guild. The `WCL_TIMEZONE` value is used when the model asks things like "last monday" — set it to your IANA zone (for example `Europe/Stockholm`).

```text
WCL_CLIENT_ID=...
WCL_CLIENT_SECRET=...
WCL_GUILD_NAME=Ancient Circle
WCL_GUILD_REGION=EU
WCL_GUILD_REALM=tarren-mill
WCL_TIMEZONE=Europe/Stockholm
```

## Register with Cursor

Add the following to `~/.cursor/mcp.json` (or your Cursor MCP config), adjusting the `cwd` path:

```json
{
  "mcpServers": {
    "ancient-circle-wcl": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "C:/Users/folkol/CursorProjects/mplight-analysis",
      "env": {
        "WCL_CLIENT_ID": "...",
        "WCL_CLIENT_SECRET": "...",
        "WCL_GUILD_NAME": "Ancient Circle",
        "WCL_GUILD_REGION": "EU",
        "WCL_GUILD_REALM": "tarren-mill",
        "WCL_TIMEZONE": "Europe/Stockholm"
      }
    }
  }
}
```

If you prefer not to keep a compiled `dist/`, you can run via `tsx` instead:

```json
"command": "npx",
"args": ["-y", "tsx", "src/server.ts"]
```

## Tools

| Tool | What it does |
|------|--------------|
| `wcl_resolve_guild` | Returns the currently configured guild and timezone. |
| `wcl_list_reports` | Lists guild reports. Accepts a natural-language `day` (`"last monday"`, `"yesterday"`, `"2026-04-13"`) or explicit `startMs`/`endMs`. |
| `wcl_report_fights` | Fights in a report, with encounter-scoped `attemptIndex` so you can say "pull #32". |
| `wcl_events` | Low-level, paginated event fetcher. Supports `dataType`, `fightIDs`, `filterExpression`, `includeResources`. |
| `wcl_analyze_death_window` | For selected fights, aggregates damage each player took in the `windowSeconds` before they died and ranks abilities by % of deaths impacted. |
| `wcl_counterfactual_ability_avoidance` | Counts deaths that had a specific ability (by name substring) hit them in the N seconds before death, with a called-wipe filter so cluster deaths do not inflate the number. |
| `wcl_player_defensives_at_time` | For a specific player death, marks tracked defensives as available or on cooldown using last-cast + nominal CD. Returns active buffs at time of death. |
| `wcl_death_map_timeline` | Deaths (with `x`/`y` when logged) plus optional boss cast markers for an encounter across all pulls in a report. |

### Example questions → tool calls

- "How did people die on Voracious last Monday?"
  1. `wcl_list_reports` with `day: "last monday"` → pick a report.
  2. `wcl_analyze_death_window` with that `reportCode` and `encounterName: "Voracious"`.

- "What defensives did PlayerX have available when they died on pull #32?"
  1. `wcl_report_fights` with an `encounterName` to find the fight and its `attemptIndex`.
  2. `wcl_player_defensives_at_time` with `encounterName`, `attemptIndex: 32`, and `playerName`.

- "Give me a death map on Salhadaar with boss events."
  1. `wcl_death_map_timeline` with `reportCode` and `encounterName: "Salhadaar"`, `includeBossCasts: true`.

## Limitations

- Defensive availability is a heuristic. It does not account for charges, haste, or talent-modified cooldowns, and it only checks the spells listed in `src/data/defensive-spells.json` — extend that file for better coverage.
- Positional data (`x`/`y`) is only present when Blizzard logged it for an event; the tool returns `null` when absent.
- This server uses OAuth client-credentials, which only sees **public** reports. Private reports require an authorization-code flow that is not implemented here.

## Bonus: print-ready playing cards (A4 duplex)

There’s a standalone print page here:

- `dist/print-playing-cards/spades-a4-duplex.html`

It prints **two A4 pages**:

- **Page 1**: as many spade faces as fit on A4 (**58 × 88 mm**, sized to fit inside 60 × 90 mm business-card laminating pouches → **9 cards**: A♠ through 9♠)
- **Page 2**: backs in the exact same positions, using a randomly chosen “playing-card-like” back design

Printing tips (for alignment):

- **Disable “fit to page” / scaling** in the print dialog (must be **100%**).
- **Duplex**: start with “flip on long edge”. If the back ends up horizontally offset, toggle **Mirror backs** in the toolbar and re-print.
- **Calibration**: do a quick test on plain paper, then hold the sheet up to a light source to verify front/back registration before using thick stock.
