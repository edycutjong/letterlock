// Latency statistics for scripts/bench.ts. Percentiles are nearest-rank: the reported value is always one of the
// measured samples, never an interpolation between two of them.

export type Summary = {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
};

/** Nearest-rank percentile of samples sorted ascending: the sample at rank ceil(p/100 * n), 1-based. */
export const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) throw new RangeError("percentile of no samples");
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
};

/** Rounds to 3 decimals: milliseconds to the microsecond. */
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export const summarize = (samples: readonly number[]): Summary => {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  return {
    n: sorted.length,
    min: round3(sorted[0]!),
    p50: round3(percentile(sorted, 50)),
    p95: round3(percentile(sorted, 95)),
    p99: round3(percentile(sorted, 99)),
    max: round3(sorted[sorted.length - 1]!),
    mean: round3(mean),
  };
};
