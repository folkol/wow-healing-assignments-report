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
