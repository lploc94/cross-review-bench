import { DEFAULT_MAX_DRIFT_MS, DEFAULT_PULL_MAX_LIMIT, DEFAULT_PUSH_MAX_MUTATIONS, isValidNodeId } from "@sync/shared";
import { z } from "zod";

const integer = (fallback: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,16}$/, "must be a non-negative integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .default(fallback);

const MIB = 1024 * 1024;

const envShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: integer(3000, 0, 65_535),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required" })
    .trim()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string"),
  DATABASE_POOL_MAX: integer(10, 1, 200),

  /** Node id of this server's hybrid logical clock; give each instance its own. */
  SERVER_NODE_ID: z
    .string()
    .trim()
    .refine(isValidNodeId, "must be lowercase letters, digits and inner dashes, at most 64")
    .default("server"),
  MAX_CLOCK_DRIFT_MS: integer(DEFAULT_MAX_DRIFT_MS, 0, 24 * 3_600_000),
  PUSH_MAX_MUTATIONS: integer(DEFAULT_PUSH_MAX_MUTATIONS, 1, 10_000),
  PULL_MAX_LIMIT: integer(DEFAULT_PULL_MAX_LIMIT, 1, 10_000),
  PULL_DEFAULT_LIMIT: integer(200, 1, 10_000),
  /** Largest request body; a full push batch of the largest documents fits in the default. */
  BODY_LIMIT_BYTES: integer(32 * MIB, 1_024, 256 * MIB),
  SHUTDOWN_TIMEOUT_MS: integer(10_000, 100, 300_000),
};

const envSchema = z.object(envShape).superRefine((env, ctx) => {
  if (env.PULL_DEFAULT_LIMIT > env.PULL_MAX_LIMIT) {
    ctx.addIssue({
      code: "custom",
      message: "must not exceed PULL_MAX_LIMIT",
      path: ["PULL_DEFAULT_LIMIT"],
    });
  }
});

type Env = z.infer<typeof envSchema>;

export interface SyncSettings {
  readonly serverNodeId: string;
  readonly maxClockDriftMs: number;
  readonly pushMaxMutations: number;
  readonly pullMaxLimit: number;
  readonly pullDefaultLimit: number;
}

export interface Config {
  readonly nodeEnv: Env["NODE_ENV"];
  readonly host: string;
  readonly port: number;
  readonly logLevel: Env["LOG_LEVEL"];
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly sync: SyncSettings;
  readonly bodyLimitBytes: number;
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

/** Read and validate the server configuration; a ConfigError lists every problem at once. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = parseEnv(envSchema, source);
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    databasePoolMax: env.DATABASE_POOL_MAX,
    sync: {
      serverNodeId: env.SERVER_NODE_ID,
      maxClockDriftMs: env.MAX_CLOCK_DRIFT_MS,
      pushMaxMutations: env.PUSH_MAX_MUTATIONS,
      pullMaxLimit: env.PULL_MAX_LIMIT,
      pullDefaultLimit: env.PULL_DEFAULT_LIMIT,
    },
    bodyLimitBytes: env.BODY_LIMIT_BYTES,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}

const scriptEnvSchema = z.object({
  DATABASE_URL: envShape.DATABASE_URL,
  LOG_LEVEL: envShape.LOG_LEVEL,
});

/** The subset of the configuration the administration scripts need. */
export function loadScriptConfig(
  source: NodeJS.ProcessEnv = process.env,
): Pick<Config, "databaseUrl" | "logLevel"> {
  const env = parseEnv(scriptEnvSchema, source);
  return { databaseUrl: env.DATABASE_URL, logLevel: env.LOG_LEVEL };
}
