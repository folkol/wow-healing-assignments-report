import { getAccessToken } from "./auth.js";

const ENDPOINT = "https://www.warcraftlogs.com/api/v2/client";

export class WclApiError extends Error {
  constructor(message: string, public readonly detail?: unknown) {
    super(message);
    this.name = "WclApiError";
  }
}

export async function gql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429) {
    throw new WclApiError("WCL API rate limited (429). Wait and retry.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new WclApiError(`WCL HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as { data?: T; errors?: unknown[] };
  if (json.errors && json.errors.length > 0) {
    throw new WclApiError("WCL GraphQL errors", json.errors);
  }
  if (!json.data) throw new WclApiError("WCL response missing data", json);
  return json.data;
}
