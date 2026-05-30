import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractReportCode,
  generateDeathHotspotsHtml,
  parseDifficulty,
} from "../audit/deathHotspots.js";

interface Args {
  report: string;
  out: string;
  encounterID?: number;
  difficulty?: number;
  includeAudit: boolean;
  open: boolean;
}

function usage(exitCode = 1): never {
  console.error(`Usage:
  npm run death-hotspots -- --report <warcraftlogs-url-or-code> [options]

Options:
  --out <file>           Output HTML file (default: death-hotspots.html)
  --encounter <id>       Encounter ID override. Defaults to most-frequent encounter in report.
  --difficulty <name|id> Difficulty override. Defaults to most-frequent difficulty in report.
  --no-audit             Skip the per-death defensive/pot audit table (faster).
  --open                 Open the HTML report after generating it.
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    report: "",
    out: "death-hotspots.html",
    includeAudit: true,
    open: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = () => argv[++i] ?? usage();
    switch (key) {
      case "--report":
        args.report = next();
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
      case "--no-audit":
        args.includeAudit = false;
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

  if (!args.report) usage();
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

  console.error(
    `Generating death hotspots for ${reportCode}${args.includeAudit ? " (with audit)" : " (discovery only)"}…`,
  );

  const html = await generateDeathHotspotsHtml({
    reportCode,
    encounterID: args.encounterID,
    difficulty: args.difficulty,
    includeAudit: args.includeAudit,
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
