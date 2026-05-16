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
