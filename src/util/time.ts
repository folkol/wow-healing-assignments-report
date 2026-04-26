/**
 * Time helpers for resolving natural language windows like "last Monday"
 * into unix-ms ranges in a specific IANA timezone.
 */

function partsInTz(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return parts;
}

/** Returns the unix-ms for the given wall-clock date in `timeZone`. */
export function zonedTimeToUtcMs(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): number {
  // Start with a UTC guess, then adjust by the offset the zone applies to that instant.
  const utcGuess = Date.UTC(y, m - 1, d, h, mi, s);
  const parts = partsInTz(new Date(utcGuess), timeZone);
  const asIfLocal = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = asIfLocal - utcGuess;
  return utcGuess - offset;
}

/** 0=Sun, 1=Mon, ... 6=Sat (matches JS Date.getDay semantics) */
export function dayOfWeekInTz(date: Date, timeZone: string): number {
  const weekday = partsInTz(date, timeZone).weekday;
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? 0;
}

/**
 * Unix-ms range [start, end) for the calendar day that is the most recent
 * occurrence of `weekday` strictly before "today" in the target timezone.
 * If `weekday === today`, returns the date exactly one week ago.
 */
export function lastWeekdayRange(
  weekday: number,
  timeZone: string,
  now: Date = new Date(),
): { startMs: number; endMs: number } {
  const parts = partsInTz(now, timeZone);
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  const todayDow = dayOfWeekInTz(now, timeZone);
  let diff = (todayDow - weekday + 7) % 7;
  if (diff === 0) diff = 7;
  const startUtc = zonedTimeToUtcMs(y, m, d, 0, 0, 0, timeZone) - diff * 86_400_000;
  const endUtc = startUtc + 86_400_000;
  return { startMs: startUtc, endMs: endUtc };
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/**
 * Resolve expressions like "last monday", "yesterday", "2025-10-06",
 * or a unix-ms number into a { startMs, endMs } range.
 * Returns null if unparseable.
 */
export function resolveDayExpression(
  expr: string | number,
  timeZone: string,
): { startMs: number; endMs: number; label: string } | null {
  if (typeof expr === "number") {
    const start = expr;
    return { startMs: start, endMs: start + 86_400_000, label: new Date(start).toISOString() };
  }
  const s = expr.trim().toLowerCase();

  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    const start = zonedTimeToUtcMs(y, m, d, 0, 0, 0, timeZone);
    return { startMs: start, endMs: start + 86_400_000, label: s };
  }

  const now = new Date();
  if (s === "today") {
    const parts = partsInTz(now, timeZone);
    const start = zonedTimeToUtcMs(
      Number(parts.year),
      Number(parts.month),
      Number(parts.day),
      0,
      0,
      0,
      timeZone,
    );
    return { startMs: start, endMs: start + 86_400_000, label: "today" };
  }
  if (s === "yesterday") {
    const parts = partsInTz(now, timeZone);
    const start =
      zonedTimeToUtcMs(
        Number(parts.year),
        Number(parts.month),
        Number(parts.day),
        0,
        0,
        0,
        timeZone,
      ) - 86_400_000;
    return { startMs: start, endMs: start + 86_400_000, label: "yesterday" };
  }

  const lastMatch = s.match(/^last\s+([a-z]+)$/);
  if (lastMatch) {
    const dow = WEEKDAYS[lastMatch[1]];
    if (dow != null) {
      const r = lastWeekdayRange(dow, timeZone, now);
      return { ...r, label: `last ${lastMatch[1]}` };
    }
  }

  const plainDow = WEEKDAYS[s];
  if (plainDow != null) {
    const r = lastWeekdayRange(plainDow, timeZone, now);
    return { ...r, label: s };
  }

  return null;
}
