# WCL Analysis Tools

Two report types are available: **Cooldown Assignment Audit** and **Death Hotspots**.

---

# Cooldown Assignment Audit

Generate an HTML timeline report from a Warcraft Logs report and a WowUtils `Copy CDs` export.

## Usage

Save the WowUtils copied assignments to a text file, for example `assignments-vanguard.txt`, then run:

```powershell
npm run cooldown-audit -- --report "https://www.warcraftlogs.com/reports/q2MY3xV6thgw8frC" --assignments assignments-vanguard.txt --out vanguard-assignment-timeline.html --open
```

The command prints a `file:///...` URL for the generated report.

## Useful Options

- `--encounter 3180`: override the encounter ID if the assignment export does not include it.
- `--difficulty Mythic`: override the difficulty if needed. Numeric IDs also work.
- `--hit-window 8`: count a cast as on-time if it lands within this many seconds of the assigned time.
- `--actual-window 60`: search this many seconds around the assigned time for the nearest matching cast.
- `--sample-offsets -10,-5,0,5,10`: choose raid-health/debuff sample points around each assignment.
- `--spell-map 325197=322118`: remap exported spell IDs to WCL cast IDs. The default includes this Chi-Ji-to-Yu'lon mapping.
- `--no-default-spell-map`: disable default spell remaps.
- `--player-map AssignmentName=WclName`: map a WowUtils tag to a different WCL player name.

## Report Contents

Each reached assignment gets:

- Assigned time and actual cast time.
- Delta from the planned time.
- Status: `hit`, `early`, `late`, or `miss`.
- Assigned-player death context.
- Expandable raid-health and debuff samples before/after the assignment.

---

## Web App (Vercel)

A hosted version of this tool is available at your Vercel deployment URL. Anyone with a generated
report link can view the report — links are public but unguessable (Vercel Blob with random suffix).

### Deploy to Vercel

1. Push this repository to GitHub/GitLab.
2. Import the project in the [Vercel dashboard](https://vercel.com/new).
3. Set the following **Environment Variables** in the Vercel project settings:

   | Variable               | Description                                           |
   |------------------------|-------------------------------------------------------|
   | `WCL_CLIENT_ID`        | Warcraft Logs OAuth2 client ID                        |
   | `WCL_CLIENT_SECRET`    | Warcraft Logs OAuth2 client secret                    |
   | `BLOB_READ_WRITE_TOKEN`| Vercel Blob token — auto-set when you add a Blob store |

4. Connect a **Vercel Blob** store to the project under **Storage → Blob** in the dashboard.
   Vercel sets `BLOB_READ_WRITE_TOKEN` automatically when you connect the store.
5. Every push to the default branch triggers a new deploy. No build configuration is needed —
   Vercel detects the `api/generate.ts` serverless function and serves `public/index.html`
   as the root static page.

### Local testing with Vercel CLI

```bash
npm install -g vercel
vercel env pull .env.local   # pulls env vars from your Vercel project
vercel dev                   # starts local dev server on http://localhost:3000
```

The `vercel dev` server mirrors the production routing: `public/` files are served statically and
`api/*.ts` files run as serverless functions.

### Timeout note

The API route requests `maxDuration: 300` seconds (requires Vercel Pro). On the Hobby tier the
hard limit is 60 seconds. Large reports with many pulls may time out on Hobby — use the CLI
locally or upgrade to Pro.

---

# Death Hotspots

Identify recurring death spikes across all pulls of a boss encounter. No WowUtils assignments
needed — just a WCL report URL.

## Usage

```powershell
npm run death-hotspots -- --report "https://www.warcraftlogs.com/reports/gTYPRBaKGVCf2Fbc" --out crown-hotspots.html --open
```

Add `--no-audit` to skip the per-death defensive/pot audit table and generate the report much faster (10–20s vs 1–3 min).

## Useful Options

- `--encounter 3181`: override the encounter ID (auto-detected from the most-frequent boss encounter if omitted).
- `--difficulty Mythic`: override the difficulty (auto-detected if omitted). Numeric IDs also work.
- `--no-audit`: generate discovery-only report (histograms, hotspot table, per-pull timeline) without the per-death defensive/pot table.
- `--open`: open the HTML report after generating it.

## Report Contents

1. **Summary cards** — pull count, raw deaths, pre-wipe deaths, wipe-cascade excluded deaths.
2. **Histograms** — aggregate deaths by 30s and 10s windows; hotspot windows highlighted.
3. **Hotspot table** — each recurring danger window with mechanic name, death count, top killing blows, and repeat offenders.
4. **Per-pull timeline** — SVG timeline per pull showing pre-wipe deaths (red = hotspot window, blue = other), orange wipe-call tick, and yellow hotspot bands.
5. **Death audit table** (with `--audit`, the default) — grouped by hotspot window, one row per death: 5s damage, top damage sources, defensives available/on-cooldown, defensives/pots used in the 5s before death.

## Wipe filter

A "wipe call" is detected when 5 or more deaths occur within any 10-second window. Only deaths
*before* that cluster count toward analysis; the wipe-cascade is excluded.

## Encounter config

Known hotspot windows are stored in `src/data/encounter-hotspots.json`. Crown of the Cosmos
(encounter 3181) is pre-configured with the six windows identified during analysis. For other
encounters without a config entry, hotspot windows are auto-detected from the 5s death histogram
using peaks that reach at least 45% of the maximum bucket.

## Web App (Death Hotspots tab)

The Death Hotspots form is on the second tab of the Vercel landing page. Fields:

- **WCL URL** — required.
- **Encounter ID** — optional; auto-detected if blank.
- **Difficulty** — optional; auto-detected if blank.
- **Include def/pot audit table** — checked by default; uncheck for a fast discovery-only report.

### Timeout note

Discovery-only mode completes in 10–20 seconds (safe on Hobby tier). The full audit with
defensive/pot analysis takes 60–180 extra seconds for a 30-pull Crown session; this requires
the Vercel Pro tier (300-second limit already configured in `vercel.json`).
