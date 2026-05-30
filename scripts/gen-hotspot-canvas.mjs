import { readFileSync, writeFileSync } from "node:fs";

const grouped = JSON.parse(readFileSync("examples/crown-hotspot-deaths-grouped.json", "utf8"));
const PHASE = {
  "0:15–0:20": "P1 — Grasp / Bursting Emptiness",
  "0:40–0:45": "P1 — Null Corona / Void Remnants",
  "1:00–1:05": "P1 — Silverstrike Arrow",
  "1:05–1:10": "P1 — Void Expulsion",
  "1:35–1:40": "P1 — Void Expulsion overlap",
  "2:35–2:40": "Intermission 1 — Silverstrike Barrage",
};

const groups = grouped.map((g) => ({
  window: g.window,
  phase: PHASE[g.window],
  rows: g.rows.map((r) => ({
    pull: r.pull,
    time: r.time,
    player: r.player,
    cls: r.class,
    kb: r.killingBlow,
    dmg: r.damage5s,
    dmgTop: r.damageTop,
    defAvail: r.defAvailable,
    defCD: r.defOnCD,
    defUsed: r.defUsed5s,
    pots: r.potsUsed5s,
    buffs: r.activeBuffs,
  })),
}));

const canvas = `import {
  Callout,
  CollapsibleSection,
  Divider,
  Grid,
  H1,
  H2,
  Stack,
  Stat,
  Table,
  Text,
  Link,
} from 'cursor/canvas';

const REPORT_URL = 'https://www.warcraftlogs.com/reports/gTYPRBaKGVCf2Fbc';
const GROUPS = ${JSON.stringify(groups, null, 2)} as const;

const HEADERS = [
  'Pull',
  'Time',
  'Player',
  'Class',
  'Killing blow',
  '5s dmg',
  'Top damage sources (5s)',
  'Def available',
  'Def on CD',
  'Def used (5s)',
  'Pots used (5s)',
  'Active buffs',
];

function rowTone(defUsed: string, defAvail: string, pots: string): 'danger' | 'warning' | undefined {
  if (defUsed === 'none' && defAvail !== '—' && pots === 'none') return 'danger';
  if (defUsed === 'none' && pots === 'none') return 'warning';
  return undefined;
}

export default function HotspotDeathAudit() {
  const total = GROUPS.reduce((n, g) => n + g.rows.length, 0);
  const noDef = GROUPS.flatMap((g) => g.rows).filter((r) => r.defUsed === 'none').length;
  const noPot = GROUPS.flatMap((g) => g.rows).filter((r) => r.pots === 'none').length;

  return (
    <Stack gap={20}>
      <H1>Crown Hotspot Deaths — 5s Window Audit</H1>
      <Text>
        Source: <Link href={REPORT_URL}>gTYPRBaKGVCf2Fbc</Link> · Pre-wipe deaths in hotspot windows only ·
        5s before death · def CD heuristic (last cast + nominal CD) · pot availability not logged by WCL
      </Text>

      <Grid columns={4} gap={16}>
        <Stat value={String(total)} label="Hotspot deaths" tone="danger" />
        <Stat value={String(noDef)} label="No def used in 5s" tone="warning" />
        <Stat value={String(noPot)} label="No pot/healthstone in 5s" />
        <Stat value="5s" label="Damage / CD window" />
      </Grid>

      <Callout tone="warning">
        39/41 had a tracked defensive off cooldown but only 2 pressed one in the last 5s (Globalisten Spell
        Reflection, Skäggbuff Bear Form). 38/41 used no pot or healthstone in the window — including Skäggbuff
        on P6 who double-dipped healthstone + pot but still died to Void Expulsion.
      </Callout>

      <Divider />

      {GROUPS.map((group) => (
        <CollapsibleSection key={group.window} title={\`\${group.window} · \${group.phase}\`} count={group.rows.length}>
          <Table
            headers={HEADERS}
            rows={group.rows.map((r) => [
              \`P\${r.pull}\`,
              r.time,
              r.player,
              r.cls,
              r.kb,
              r.dmg,
              r.dmgTop,
              r.defAvail,
              r.defCD,
              r.defUsed,
              r.pots,
              r.buffs,
            ])}
            rowTone={group.rows.map((r) => rowTone(r.defUsed, r.defAvail, r.pots))}
          />
        </CollapsibleSection>
      ))}

      <Text size="small" tone="tertiary">
        Defensive list is class kit from defensive-spells.json; only spells seen cast at least once in the report
        are included. "Available" = off CD at death by last-cast heuristic.
      </Text>
    </Stack>
  );
}
`;

writeFileSync(
  "C:/Users/folkol/.cursor/projects/c-Users-folkol-CursorProjects-mplight-analysis/canvases/crown-hotspot-death-audit.canvas.tsx",
  canvas,
);
console.log("canvas written", groups.reduce((n, g) => n + g.rows.length, 0), "rows");
