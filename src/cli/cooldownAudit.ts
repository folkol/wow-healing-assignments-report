import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_SPELL_MAP,
  extractReportCode,
  generateAuditHtml,
  parseAssignmentsHeader,
  parseDifficulty,
} from "../audit/generate.js";

interface Args {
  report: string;
  assignments: string;
  out: string;
  encounterID?: number;
  difficulty?: number;
  hitWindowSec: number;
  actualWindowSec: number;
  sampleOffsets: number[];
  maxEvents: number;
  open: boolean;
  spellMap: Map<number, number>;
  playerMap: Map<string, string>;
}

function usage(exitCode = 1): never {
  console.error(`Usage:
  npm run cooldown-audit -- --report <warcraftlogs-url-or-code> --assignments <wowutils-copy-cds.txt> [options]

Options:
  --out <file>                Output HTML file (default: cooldown-audit.html)
  --encounter <id>            Encounter ID override. Defaults to EncounterID from assignments.
  --difficulty <name|id>      Difficulty override. Defaults to Difficulty from assignments.
  --hit-window <seconds>      On-time cast window around assignment (default: 8)
  --actual-window <seconds>   Nearest cast search window (default: 60)
  --sample-offsets <list>     Health/debuff sample offsets, seconds (default: -10,-5,0,5,10)
  --spell-map <from=to,...>   Spell ID remaps. Default includes 325197=322118.
  --no-default-spell-map      Disable default spell remaps.
  --player-map <from=to,...>  Map assignment tags to WCL player names.
  --max-events <count>        Event cap per stream (default: 250000)
  --open                      Open the HTML report after generating it.
`);
  process.exit(exitCode);
}

function mergeMap<T extends number | string>(
  map: Map<T, T>,
  text: string,
  numeric: boolean,
): void {
  for (const part of text.split(",")) {
    const [from, to] = part.split("=").map((v) => v?.trim());
    if (!from || !to) continue;
    if (numeric) {
      map.set(Number(from) as T, Number(to) as T);
    } else {
      map.set(from as T, to as T);
    }
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    report: "",
    assignments: "",
    out: "cooldown-audit.html",
    hitWindowSec: 8,
    actualWindowSec: 60,
    sampleOffsets: [-10, -5, 0, 5, 10],
    maxEvents: 250_000,
    open: false,
    spellMap: new Map(DEFAULT_SPELL_MAP),
    playerMap: new Map(),
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = () => argv[++i] ?? usage();
    switch (key) {
      case "--report":
        args.report = next();
        break;
      case "--assignments":
        args.assignments = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--encounter":
        args.encounterID = Number.parseInt(next(), 10);
        break;
      case "--difficulty":
        args.difficulty = parseDifficulty(next());
        break;
      case "--hit-window":
        args.hitWindowSec = Number.parseFloat(next());
        break;
      case "--actual-window":
        args.actualWindowSec = Number.parseFloat(next());
        break;
      case "--sample-offsets":
        args.sampleOffsets = next()
          .split(",")
          .map((v) => Number.parseFloat(v.trim()))
          .filter((v) => Number.isFinite(v));
        break;
      case "--spell-map":
        mergeMap(args.spellMap, next(), true);
        break;
      case "--no-default-spell-map":
        args.spellMap.clear();
        break;
      case "--player-map":
        mergeMap(args.playerMap, next(), false);
        break;
      case "--max-events":
        args.maxEvents = Number.parseInt(next(), 10);
        break;
      case "--open":
        args.open = true;
        break;
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        console.error(`Unknown argument: ${key}`);
        usage();
    }
  }

  if (!args.report || !args.assignments) usage();
  return args;
}

function openFile(path: string): void {
  const url = pathToFileURL(path).href;
  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, cmdArgs, { detached: true, stdio: "ignore" }).unref();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reportCode = extractReportCode(args.report);
  const assignmentText = readFileSync(resolve(args.assignments), "utf8");
  const header = parseAssignmentsHeader(assignmentText);
  const encounterID = args.encounterID ?? header.encounterID;
  const difficulty = args.difficulty ?? header.difficulty;
  if (!encounterID) throw new Error("Encounter ID is required, either in assignments or --encounter.");
  if (!difficulty) throw new Error("Difficulty is required, either in assignments or --difficulty.");

  const html = await generateAuditHtml({
    reportCode,
    assignmentText,
    encounterID,
    difficulty,
    options: {
      hitWindowSec: args.hitWindowSec,
      actualWindowSec: args.actualWindowSec,
      sampleOffsets: args.sampleOffsets,
      maxEvents: args.maxEvents,
      spellMap: args.spellMap,
      playerMap: args.playerMap,
    },
    onProgress: (msg) => console.error(msg),
  });

  const outPath = resolve(args.out);
  writeFileSync(outPath, html, "utf8");
  console.log(`Wrote ${outPath}`);
  console.log(`Open: ${pathToFileURL(outPath).href}`);
  if (args.open) openFile(outPath);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
