import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put } from "@vercel/blob";
import {
  extractReportCode,
  generateDeathHotspotsHtml,
  parseDifficulty,
} from "../src/audit/deathHotspots.js";

interface RequestBody {
  report?: string;
  encounterID?: number;
  difficulty?: string | number;
  includeAudit?: boolean;
}

function getBaseUrl(req: VercelRequest): string {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  if (!host || Array.isArray(host)) {
    return "https://wow-healing-assignments-report.vercel.app";
  }
  const protoHeader = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) ?? "https";
  return `${proto}://${host}`;
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

  const { report } = body;
  if (!report || typeof report !== "string") {
    res.status(400).json({ error: "Missing required field: report" });
    return;
  }

  let encounterID: number | undefined =
    typeof body.encounterID === "number" ? body.encounterID : undefined;

  let difficulty: number | undefined;
  if (body.difficulty !== undefined) {
    const raw = body.difficulty;
    difficulty =
      typeof raw === "number" ? raw : parseDifficulty(String(raw));
  }

  const includeAudit = typeof body.includeAudit === "boolean" ? body.includeAudit : true;
  const reportCode = extractReportCode(report);

  try {
    const html = await generateDeathHotspotsHtml({
      reportCode,
      encounterID,
      difficulty,
      includeAudit,
    });

    const filename = `death-hotspots-${reportCode}.html`;
    const blob = await put(filename, html, {
      access: "public",
      addRandomSuffix: true,
      contentType: "text/html; charset=utf-8",
    });

    const viewUrl = `${getBaseUrl(req)}/api/view?pathname=${encodeURIComponent(blob.pathname)}`;
    res.status(200).json({ url: viewUrl });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Death hotspots generation failed:", message);
    res.status(500).json({ error: message });
  }
}
