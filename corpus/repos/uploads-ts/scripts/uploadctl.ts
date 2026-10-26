import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { ApiError, DEFAULT_CHUNK_SIZE, UploadsClient } from "../src/client/uploadsClient.js";

/**
 * Command-line access to the uploads API. The API's address and key come from UPLOADS_URL and
 * UPLOADS_TOKEN.
 */
const USAGE = `usage: uploadctl <command> [options]

  put <local file> <remote path> [--overwrite] [--content-type <type>]
  upload <local file> <remote path> [--overwrite] [--content-type <type>] [--chunk-size <bytes>]
         [--session <id>]                       resumable upload, chunk by chunk
  get <remote path> <local file>
  list [--after <cursor>] [--limit <n>] [--all]
  delete <remote path>
  signed-url <file id> [--expires-in <seconds>]
  usage

environment: UPLOADS_URL (e.g. http://localhost:3000), UPLOADS_TOKEN (an up_… API key)`;

class UsageError extends Error {}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,15}$/.test(value)) throw new UsageError(`--${name} must be a positive integer`);
  return Number(value);
}

function client(): UploadsClient {
  const baseUrl = process.env.UPLOADS_URL;
  const token = process.env.UPLOADS_TOKEN;
  if (!baseUrl || !token) throw new UsageError("UPLOADS_URL and UPLOADS_TOKEN must be set");
  return new UploadsClient({ baseUrl, token });
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        overwrite: { type: "boolean", default: false },
        "content-type": { type: "string" },
        "chunk-size": { type: "string" },
        session: { type: "string" },
        after: { type: "string" },
        limit: { type: "string" },
        all: { type: "boolean", default: false },
        "expires-in": { type: "string" },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  const arg = (index: number, name: string): string => {
    const value = args[index];
    if (value === undefined) throw new UsageError(`${command ?? "command"} needs <${name}>`);
    return value;
  };
  const contentType = values["content-type"];

  switch (command) {
    case "put": {
      const local = arg(0, "local file");
      const { size } = await stat(local);
      const stored = await client().putFile(arg(1, "remote path"), createReadStream(local), {
        size,
        overwrite: values.overwrite,
        ...(contentType === undefined ? {} : { contentType }),
      });
      print(stored);
      return;
    }
    case "upload": {
      const stored = await client().uploadFileResumable(arg(0, "local file"), arg(1, "remote path"), {
        chunkSize: positiveInteger(values["chunk-size"], "chunk-size", DEFAULT_CHUNK_SIZE),
        overwrite: values.overwrite,
        ...(contentType === undefined ? {} : { contentType }),
        ...(values.session === undefined ? {} : { sessionId: values.session }),
        onProgress: (uploaded, total) => process.stderr.write(`\r${uploaded}/${total} bytes`),
      });
      process.stderr.write("\n");
      print(stored);
      return;
    }
    case "get": {
      const download = await client().getFile(arg(0, "remote path"));
      const target = arg(1, "local file");
      // "wx": never overwrite a local file; one this command created is removed if the download fails.
      const output = createWriteStream(target, { flags: "wx" });
      let created = false;
      output.once("open", () => {
        created = true;
      });
      try {
        await pipeline(download.body, output);
      } catch (err) {
        if (created) await rm(target, { force: true });
        throw err;
      }
      return;
    }
    case "list": {
      const api = client();
      if (values.all) {
        for await (const file of api.listAll()) print(file);
        return;
      }
      const limit = values.limit === undefined ? undefined : positiveInteger(values.limit, "limit", 1);
      print(
        await api.list({
          ...(values.after === undefined ? {} : { after: values.after }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );
      return;
    }
    case "delete":
      await client().deleteFile(arg(0, "remote path"));
      return;
    case "signed-url":
      print(
        await client().createSignedUrl(
          arg(0, "file id"),
          positiveInteger(values["expires-in"], "expires-in", 3600),
        ),
      );
      return;
    case "usage":
      print(await client().getTenant());
      return;
    default:
      throw new UsageError(command === undefined ? "a command is required" : `unknown command ${command}`);
  }
}

try {
  await run(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
  } else if (err instanceof ApiError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
