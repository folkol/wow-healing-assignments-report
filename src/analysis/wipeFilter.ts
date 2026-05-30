/**
 * Wipe-cluster detection: a wipe call occurs when 5+ deaths happen within a 10s window.
 * Only deaths *before* the wipe call count toward hotspot analysis.
 */

export interface SimpleDeath {
  tIntoFightMs: number;
  fightID?: number;
}

export interface WipeFilterOptions {
  /** Deaths in window required to declare a wipe call. Default 5. */
  minDeaths?: number;
  /** Sliding window width in seconds. Default 10. */
  windowSec?: number;
}

/**
 * Find the time (in seconds into the fight) when a wipe is called.
 * Returns `null` if no wipe cluster is detected.
 *
 * Algorithm: slide through sorted deaths; at each death check whether
 * `minDeaths` or more deaths fall in [death.t, death.t + windowSec). The
 * first such cluster's start time is the wipe call.
 */
export function findWipeCallSec(
  deaths: SimpleDeath[],
  opts: WipeFilterOptions = {},
): number | null {
  const minDeaths = opts.minDeaths ?? 5;
  const windowSec = opts.windowSec ?? 10;

  const sorted = [...deaths].sort((a, b) => a.tIntoFightMs - b.tIntoFightMs);
  for (let i = 0; i < sorted.length; i++) {
    const startSec = sorted[i].tIntoFightMs / 1000;
    const endSec = startSec + windowSec;
    let count = 0;
    for (const d of sorted) {
      const sec = d.tIntoFightMs / 1000;
      if (sec >= startSec && sec < endSec) count++;
    }
    if (count >= minDeaths) return startSec;
  }
  return null;
}

/**
 * Keep only deaths that occurred *before* the wipe call.
 * If no wipe cluster is detected, all deaths are returned.
 */
export function filterPreWipeDeaths<T extends SimpleDeath>(
  deaths: T[],
  opts: WipeFilterOptions = {},
): { prewipe: T[]; wipeSec: number | null } {
  const wipeSec = findWipeCallSec(deaths, opts);
  const prewipe =
    wipeSec == null ? deaths : deaths.filter((d) => d.tIntoFightMs / 1000 < wipeSec);
  return { prewipe, wipeSec };
}
