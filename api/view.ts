import type { VercelRequest, VercelResponse } from "@vercel/node";
import { get } from "@vercel/blob";

/** Blob pathnames from generate.ts — unguessable via addRandomSuffix. */
const PATHNAME_RE = /^cooldown-audit-[A-Za-z0-9._-]+\.html$/;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).setHeader("Allow", "GET").end("Method not allowed");
    return;
  }

  const pathname = typeof req.query.pathname === "string" ? req.query.pathname : undefined;
  if (!pathname || !PATHNAME_RE.test(pathname) || pathname.includes("..")) {
    res.status(400).end("Invalid report link");
    return;
  }

  try {
    const result = await get(pathname, { access: "public" });
    if (!result?.stream) {
      res.status(404).end("Report not found");
      return;
    }

    const html = await new Response(result.stream as ReadableStream).text();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="cooldown-audit.html"');
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.status(200).send(html);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("View report failed:", message);
    res.status(500).end("Failed to load report");
  }
}
