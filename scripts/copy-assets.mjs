import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const assets = [
  ["src/data/defensive-spells.json", "dist/data/defensive-spells.json"],
];

for (const [from, to] of assets) {
  const src = resolve(root, from);
  const dst = resolve(root, to);
  if (!existsSync(src)) continue;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  process.stdout.write(`copied ${from} -> ${to}\n`);
}
