import { z } from "zod";

const integer = (fallback: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, "must be a non-negative integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .default(fallback);

const envShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: integer(3000, 0, 65_535),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z
    .string()
    .trim()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string"),
  DATABASE_POOL_MAX: integer(10, 1, 200),
  REDIS_URL: z
    .string()
    .trim()
    .regex(/^rediss?:\/\//, "must be a redis:// connection string"),
  RATE_LIMIT_PER_MINUTE: integer(600, 1, 1_000_000),
  OUTBOX_BATCH_SIZE: integer(50, 1, 1_000),
  OUTBOX_POLL_INTERVAL_MS: integer(1_000, 10, 600_000),
  OUTBOX_BACKOFF_BASE_MS: integer(5_000, 1, 3_600_000),
  OUTBOX_BACKOFF_MAX_MS: integer(3_600_000, 1, 86_400_000),
  WEBHOOK_TIMEOUT_MS: integer(5_000, 100, 120_000),
  SHUTDOWN_TIMEOUT_MS: integer(10_000, 100, 300_000),
};

const envSchema = z
  .object(envShape)
  .refine((env) => env.OUTBOX_BACKOFF_MAX_MS >= env.OUTBOX_BACKOFF_BASE_MS, {
    error: "must be at least OUTBOX_BACKOFF_BASE_MS",
    path: ["OUTBOX_BACKOFF_MAX_MS"],
  });

type Env = z.infer<typeof envSchema>;

export interface Config {
  readonly nodeEnv: Env["NODE_ENV"];
  readonly host: string;
  readonly port: number;
  readonly logLevel: Env["LOG_LEVEL"];
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly redisUrl: string;
  readonly rateLimitPerMinute: number;
  readonly outbox: {
    readonly batchSize: number;
    readonly pollIntervalMs: number;
    readonly backoffBaseMs: number;
    readonly backoffMaxMs: number;
  };
  readonly webhookTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid configuration:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Validate `source` against `schema`; blank variables count as unset (an empty line in an env file). */
function parseEnv<S extends z.ZodType>(schema: S, source: NodeJS.ProcessEnv): z.output<S> {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/** Read and validate the service configuration; a ConfigError lists every problem at once. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = parseEnv(envSchema, source);
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    databasePoolMax: env.DATABASE_POOL_MAX,
    redisUrl: env.REDIS_URL,
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    outbox: {
      batchSize: env.OUTBOX_BATCH_SIZE,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      backoffBaseMs: env.OUTBOX_BACKOFF_BASE_MS,
      backoffMaxMs: env.OUTBOX_BACKOFF_MAX_MS,
    },
    webhookTimeoutMs: env.WEBHOOK_TIMEOUT_MS,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}

const scriptEnvSchema = z.object({
  DATABASE_URL: envShape.DATABASE_URL,
  LOG_LEVEL: envShape.LOG_LEVEL,
});

/** The subset of the configuration the command-line scripts need (no Redis, no HTTP). */
export function loadScriptConfig(
  source: NodeJS.ProcessEnv = process.env,
): Pick<Config, "databaseUrl" | "logLevel"> {
  const env = parseEnv(scriptEnvSchema, source);
  return { databaseUrl: env.DATABASE_URL, logLevel: env.LOG_LEVEL };
}
