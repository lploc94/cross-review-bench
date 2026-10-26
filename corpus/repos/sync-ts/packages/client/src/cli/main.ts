import { SyncError, systemClock, type PullResponse, type PushResponse } from "@sync/shared";
import { SyncClient } from "../sync/syncClient.js";
import { HttpTransport } from "../transport/httpTransport.js";
import type { SyncTransport } from "../transport/transport.js";
import { parseArgs, UsageError } from "./args.js";
import { COMMANDS_USAGE, runCommand } from "./commands.js";
import { CliConfigError, loadCliConfig } from "./env.js";

export const USAGE = `usage: sync-cli <command> [arguments] [--db <file>] [--server <url>] [--token <token>]

${COMMANDS_USAGE}

environment: SYNC_DB (default replica.sqlite), SYNC_SERVER_URL, SYNC_TOKEN, SYNC_TIMEOUT_MS`;

/** Exit codes: 0 success, 1 failure, 2 usage, 75 temporary failure (try again later). */
export const EXIT_TEMPORARY_FAILURE = 75;

/** Stands in for the server when none is configured: local commands work, sync explains why not. */
class UnconfiguredTransport implements SyncTransport {
  private fail(): never {
    throw new SyncError(
      "server_not_configured",
      "no server configured: set SYNC_SERVER_URL and SYNC_TOKEN, or pass --server and --token",
    );
  }

  async push(): Promise<PushResponse> {
    return this.fail();
  }

  async pull(): Promise<PullResponse> {
    return this.fail();
  }
}

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** The command-line client; returns the exit code. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  let args;
  let config;
  try {
    args = parseArgs(argv);
    config = loadCliConfig(env);
  } catch (err) {
    if (err instanceof UsageError || err instanceof CliConfigError) {
      io.err(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }
  if (args.command === null || args.command === "help") {
    io.out(USAGE);
    return args.command === null ? 2 : 0;
  }

  const serverUrl = args.options.get("server") ?? config.serverUrl;
  const token = args.options.get("token") ?? config.token;
  const http =
    serverUrl !== null && token !== null
      ? new HttpTransport({ baseUrl: serverUrl, token, timeoutMs: config.timeoutMs })
      : null;

  let client: SyncClient | null = null;
  try {
    client = SyncClient.open({
      dbPath: args.options.get("db") ?? config.dbPath,
      transport: http ?? new UnconfiguredTransport(),
      clock: systemClock,
    });
    return await runCommand(args, {
      client,
      server: http,
      out: io.out,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof SyncError) {
      io.err(`${err.code}: ${err.message}`);
      return err.retryable ? EXIT_TEMPORARY_FAILURE : 1;
    }
    if (err instanceof RangeError) {
      io.err(err.message);
      return 2;
    }
    throw err;
  } finally {
    await client?.close();
  }
}
