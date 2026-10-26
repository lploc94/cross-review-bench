// Fixed run settings from the plan: reviewer configs (F5), concurrency (F18), capacity limits.

export const REVIEWERS = ["codex", "claude", "agy"];
export const SETS = ["smoke", "pilot", "calibration", "final"];
export const TRACKS = ["A", "B", "C"];

/** F5: model and effort per config. agy's highest level for argon is high, so its max row reuses the high runs. */
export const CONFIGS = {
  high: {
    codex: { model: "gpt-6-astra", effort: "high" },
    claude: { model: "claude-opus-5-5", effort: "high" },
    agy: { model: "gemini-4-argon", effort: "high" },
  },
  max: {
    codex: { model: "gpt-6-astra", effort: "max" },
    claude: { model: "claude-opus-5-5", effort: "max" },
  },
};

/** F18 default; Phase 9 measures quota and METHODOLOGY.md fixes the final values. */
export const DEFAULT_CONCURRENCY = { codex: 3, claude: 3, agy: 2 };

/** F8: per-repo corpus quotas (`crb validate --repo R --stats`). */
export const QUOTAS = {
  kinds: { buggy: 11, clean: 3, decoy: 2 },
  bugsPerTask: { 1: 7, 2: 3, 3: 1 },
  difficulty: { L1: 3, L2: 5, L3: 5, L4: 3 },
  severity: { critical: 2, high: 6, medium: 6, low: 2 },
  minCategories: 6,
  maxUntestable: 3,
};

/** Capacity: round timeout (Track A/B), passed to the runner as --timeout. */
export const ROUND_TIMEOUT_S = 7200;

/** Capacity: retries and backoff. */
export const RETRY = {
  infraRetries: 3,           // per run; then infra_exhausted (re-launchable)
  reviewerRetries: 1,        // timeout or stall; then a scored reviewer failure (I10)
  infraDelayMs: 60_000,      // between retries of other infra faults
  usageBaseMs: 30 * 60_000,  // usage limit: pause that reviewer's queue 30 min,
  usageMaxMs: 4 * 3_600_000, // doubling up to 4 h
};

/** Capacity: `crb run` refuses to start a batch below this much free disk. */
export const MIN_FREE_BYTES = 20e9;
