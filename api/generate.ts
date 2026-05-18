import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put } from "@vercel/blob";
import {
  DEFAULT_SPELL_MAP,
  extractReportCode,
  generateAuditHtml,
  parseAssignmentsHeader,
  parseDifficulty,
} from "../src/audit/generate.js";

interface RequestBody {
  report?: string;
  assignments?: string;
  encounterID?: number;
  difficulty?: string | number;
  hitWindowSec?: number;
  actualWindowSec?: number;
  sampleOffsets?: number[];
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body: RequestBody;
  try {
    body = req.body as RequestBody;
    if (!body || typeof body !== "object") throw new Error("Invalid JSON body");
  } catch {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const { report, assignments } = body;

  if (!report || typeof report !== "string") {
    res.status(400).json({ error: "Missing required field: report" });
    return;
  }
  if (!assignments || typeof assignments !== "string") {
    res.status(400).json({ error: "Missing required field: assignments" });
    return;
  }

  const header = parseAssignmentsHeader(assignments);

  let encounterID: number | undefined =
    typeof body.encounterID === "number" ? body.encounterID : header.encounterID;
  let difficulty: number | undefined = header.difficulty;

  if (body.difficulty !== undefined) {
    const raw = body.difficulty;
    difficulty =
      typeof raw === "number" ? raw : parseDifficulty(String(raw));
  }

  if (!encounterID) {
    res.status(400).json({
      error: "Encounter ID is required. Include EncounterID in the assignments header or pass encounterID in the request body.",
    });
    return;
  }
  if (!difficulty) {
    res.status(400).json({
      error: "Difficulty is required. Include Difficulty in the assignments header or pass difficulty in the request body.",
    });
    return;
  }

  const reportCode = extractReportCode(report);

  try {
    const spellMap = new Map(DEFAULT_SPELL_MAP);
    const html = await generateAuditHtml({
      reportCode,
      assignmentText: assignments,
      encounterID,
      difficulty,
      options: {
        hitWindowSec: typeof body.hitWindowSec === "number" ? body.hitWindowSec : undefined,
        actualWindowSec: typeof body.actualWindowSec === "number" ? body.actualWindowSec : undefined,
        sampleOffsets: Array.isArray(body.sampleOffsets) ? body.sampleOffsets : undefined,
        spellMap,
      },
    });

    const filename = `cooldown-audit-${reportCode}.html`;
    const { url } = await put(filename, html, {
      access: "public",
      addRandomSuffix: true,
      contentType: "text/html; charset=utf-8",
    });

    res.status(200).json({ url });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Audit generation failed:", message);
    res.status(500).json({ error: message });
  }
}
