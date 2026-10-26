import { z } from "zod";

/**
 * Configuration of the command-line client, from the environment; command-line options override
 * it. The token and the server URL are only needed by commands that talk to the server.
 */
const envSchema = z.object({
  SYNC_SERVER_URL: z.url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" }).optional(),
  SYNC_TOKEN: z.string().trim().min(1).optional(),
  SYNC_DB: z.string().trim().min(1).default("replica.sqlite"),
  SYNC_TIMEOUT_MS: z
    .string()
    .regex(/^\d{1,9}$/, "must be a positive integer")
    .transform(Number)
    .pipe(z.int().min(1).max(600_000))
    .default(30_000),
});

export interface CliConfig {
  readonly serverUrl: string | null;
  readonly token: string | null;
  readonly dbPath: string;
  readonly timeoutMs: number;
}

export class CliConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid configuration:\n  ${issues.join("\n  ")}`);
    this.name = "CliConfigError";
    this.issues = issues;
  }
}

/** Read the environment; blank variables count as unset. */
export function loadCliConfig(source: NodeJS.ProcessEnv = process.env): CliConfig {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    throw new CliConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return {
    serverUrl: parsed.data.SYNC_SERVER_URL ?? null,
    token: parsed.data.SYNC_TOKEN ?? null,
    dbPath: parsed.data.SYNC_DB,
    timeoutMs: parsed.data.SYNC_TIMEOUT_MS,
  };
}
