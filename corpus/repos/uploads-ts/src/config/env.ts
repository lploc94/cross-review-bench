import { z } from "zod";

const integer = (fallback: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,16}$/, "must be a non-negative integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .default(fallback);

const optionalText = z.string().trim().min(1).optional();

/** S3 accepts at most 5 GiB in one PutObject request, and the S3 driver uploads in one request. */
export const MAX_SINGLE_PUT_BYTES = 5 * 1024 ** 3;

const DAY_S = 86_400;

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

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_ROOT: z.string().trim().min(1).default(".data/storage"),
  S3_ENDPOINT: z
    .url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" })
    .optional(),
  S3_REGION: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,32}$/, "must be a region name such as eu-west-1")
    .optional(),
  S3_BUCKET: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "must be a valid bucket name")
    .optional(),
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,
  S3_REQUEST_TIMEOUT_MS: integer(30_000, 100, 600_000),

  MAX_UPLOAD_BYTES: integer(100 * 1024 ** 2, 1, MAX_SINGLE_PUT_BYTES),
  UPLOAD_SESSION_TTL_S: integer(DAY_S, 60, 30 * DAY_S),
  UPLOAD_CHUNK_LEASE_S: integer(600, 30, DAY_S),

  SIGNING_SECRET: z
    .string({ error: "SIGNING_SECRET is required" })
    .min(32, "must be at least 32 characters"),
  SIGNED_URL_MAX_TTL_S: integer(7 * DAY_S, 1, 30 * DAY_S),
  LIST_MAX_LIMIT: integer(1_000, 1, 10_000),

  SCANNER: z.enum(["noop", "http"]).default("noop"),
  SCANNER_URL: z
    .url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" })
    .optional(),
  SCANNER_TIMEOUT_MS: integer(30_000, 100, 600_000),
  SCAN_MAX_ATTEMPTS: integer(5, 1, 100),
  SCAN_BACKOFF_BASE_S: integer(30, 1, DAY_S),
  SCAN_BACKOFF_MAX_S: integer(3_600, 1, 7 * DAY_S),
  SCAN_BATCH_SIZE: integer(10, 1, 500),
  SCAN_POLL_INTERVAL_MS: integer(2_000, 10, 600_000),
  SCAN_CLAIM_LEASE_S: integer(300, 10, DAY_S),

  CLEANUP_INTERVAL_S: integer(300, 1, DAY_S),
  CLEANUP_BATCH_SIZE: integer(100, 1, 10_000),
  DELETED_GRACE_S: integer(DAY_S, 0, 365 * DAY_S),

  SHUTDOWN_TIMEOUT_MS: integer(10_000, 100, 300_000),
};

const S3_VARIABLES = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

const envSchema = z.object(envShape).superRefine((env, ctx) => {
  if (env.STORAGE_DRIVER === "s3") {
    for (const name of S3_VARIABLES) {
      if (env[name] === undefined) {
        ctx.addIssue({ code: "custom", message: "is required when STORAGE_DRIVER=s3", path: [name] });
      }
    }
  }
  if (env.SCANNER === "http" && env.SCANNER_URL === undefined) {
    ctx.addIssue({ code: "custom", message: "is required when SCANNER=http", path: ["SCANNER_URL"] });
  }
  if (env.SCAN_BACKOFF_MAX_S < env.SCAN_BACKOFF_BASE_S) {
    ctx.addIssue({
      code: "custom",
      message: "must be at least SCAN_BACKOFF_BASE_S",
      path: ["SCAN_BACKOFF_MAX_S"],
    });
  }
});

type Env = z.infer<typeof envSchema>;

export type StorageDriverName = Env["STORAGE_DRIVER"];

export interface S3Settings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly requestTimeoutMs: number;
}

export interface Config {
  readonly nodeEnv: Env["NODE_ENV"];
  readonly host: string;
  readonly port: number;
  readonly logLevel: Env["LOG_LEVEL"];
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly storage: {
    readonly driver: StorageDriverName;
    readonly localRoot: string;
    /** Set when the driver is s3. */
    readonly s3: S3Settings | null;
  };
  readonly uploads: {
    readonly maxUploadBytes: number;
    readonly sessionTtlSeconds: number;
    readonly chunkLeaseSeconds: number;
  };
  readonly signing: {
    readonly secret: string;
    readonly maxTtlSeconds: number;
  };
  readonly listMaxLimit: number;
  readonly scanner: {
    readonly kind: Env["SCANNER"];
    readonly url: string | null;
    readonly timeoutMs: number;
  };
  readonly scan: {
    readonly maxAttempts: number;
    readonly backoffBaseSeconds: number;
    readonly backoffMaxSeconds: number;
    readonly batchSize: number;
    readonly pollIntervalMs: number;
    readonly claimLeaseSeconds: number;
  };
  readonly cleanup: {
    readonly intervalSeconds: number;
    readonly batchSize: number;
    readonly deletedGraceSeconds: number;
  };
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

function s3Settings(env: Env): S3Settings | null {
  if (env.STORAGE_DRIVER !== "s3") return null;
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_ENDPOINT || !S3_REGION || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    // The schema already reported these; this keeps the types honest.
    throw new ConfigError(["S3 settings are incomplete"]);
  }
  return {
    endpoint: S3_ENDPOINT.replace(/\/+$/, ""),
    region: S3_REGION,
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    requestTimeoutMs: env.S3_REQUEST_TIMEOUT_MS,
  };
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
    storage: {
      driver: env.STORAGE_DRIVER,
      localRoot: env.STORAGE_LOCAL_ROOT,
      s3: s3Settings(env),
    },
    uploads: {
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
      sessionTtlSeconds: env.UPLOAD_SESSION_TTL_S,
      chunkLeaseSeconds: env.UPLOAD_CHUNK_LEASE_S,
    },
    signing: {
      secret: env.SIGNING_SECRET,
      maxTtlSeconds: env.SIGNED_URL_MAX_TTL_S,
    },
    listMaxLimit: env.LIST_MAX_LIMIT,
    scanner: {
      kind: env.SCANNER,
      url: env.SCANNER_URL ?? null,
      timeoutMs: env.SCANNER_TIMEOUT_MS,
    },
    scan: {
      maxAttempts: env.SCAN_MAX_ATTEMPTS,
      backoffBaseSeconds: env.SCAN_BACKOFF_BASE_S,
      backoffMaxSeconds: env.SCAN_BACKOFF_MAX_S,
      batchSize: env.SCAN_BATCH_SIZE,
      pollIntervalMs: env.SCAN_POLL_INTERVAL_MS,
      claimLeaseSeconds: env.SCAN_CLAIM_LEASE_S,
    },
    cleanup: {
      intervalSeconds: env.CLEANUP_INTERVAL_S,
      batchSize: env.CLEANUP_BATCH_SIZE,
      deletedGraceSeconds: env.DELETED_GRACE_S,
    },
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}

const scriptEnvSchema = z.object({
  DATABASE_URL: envShape.DATABASE_URL,
  LOG_LEVEL: envShape.LOG_LEVEL,
});

/** The subset of the configuration the administration scripts need (no storage, no HTTP). */
export function loadScriptConfig(
  source: NodeJS.ProcessEnv = process.env,
): Pick<Config, "databaseUrl" | "logLevel"> {
  const env = parseEnv(scriptEnvSchema, source);
  return { databaseUrl: env.DATABASE_URL, logLevel: env.LOG_LEVEL };
}
