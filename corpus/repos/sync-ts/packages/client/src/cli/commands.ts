import {
  COLLECTION_NAMES,
  type MeResponse,
  type RegisterDeviceResponse,
  isCollectionName,
  type CollectionName,
  type FieldsOf,
  type SyncStatusResponse,
} from "@sync/shared";
import type { SyncClient } from "../sync/syncClient.js";
import { UsageError, type ParsedArgs } from "./args.js";
import { parseAssignments } from "./fieldValues.js";

/** What the commands can ask the server outside of a sync; null when no server is configured. */
export interface ServerAccount {
  status(): Promise<SyncStatusResponse>;
  me(): Promise<MeResponse>;
  registerDevice(name: string): Promise<RegisterDeviceResponse>;
}

export interface CommandContext {
  readonly client: SyncClient;
  readonly server: ServerAccount | null;
  readonly out: (line: string) => void;
}

function requireServer(ctx: CommandContext): ServerAccount {
  if (!ctx.server) {
    throw new UsageError("this command needs a server: set SYNC_SERVER_URL and SYNC_TOKEN, or pass --server and --token");
  }
  return ctx.server;
}

export const COMMANDS_USAGE = `commands:
  set <collection> <id> <field>=<value>...   write fields locally (sent by the next sync)
  get <collection> <id>                      print a document as JSON
  list <collection>                          print the ids and titles of a collection
  sync                                       push local changes and pull remote ones
  status                                     pending changes and pull position
  whoami                                     the user and device of the token
  add-device <name>                          register another device; prints its token once
collections: ${COLLECTION_NAMES.join(", ")}
values: text as is; true/false; integers; lists comma-separated (tags=a,b); null clears dueDate and noteId`;

function collectionArg(value: string | undefined): CollectionName {
  if (value === undefined) throw new UsageError("a collection is required");
  if (!isCollectionName(value)) {
    throw new UsageError(`unknown collection ${value} (expected ${COLLECTION_NAMES.join(" or ")})`);
  }
  return value;
}

function idArg(value: string | undefined): string {
  if (value === undefined) throw new UsageError("a document id is required");
  return value;
}

function expectArgs(args: ParsedArgs, count: number): void {
  if (args.positionals.length > count) {
    throw new UsageError(`${args.command ?? "command"} takes ${count} argument(s)`);
  }
}

/** Run one command against an open client. Returns the process exit code. */
export async function runCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const { client, out } = ctx;
  const [first, second, ...rest] = args.positionals;
  switch (args.command) {
    case "set": {
      const collection = collectionArg(first);
      const id = idArg(second);
      const fields = parseAssignments(collection, rest) as FieldsOf<typeof collection>;
      const mutation = client.set(collection, id, fields);
      out(`${collection}/${id} updated (mutation ${mutation.mutationId}, ${client.pendingCount()} pending)`);
      return 0;
    }
    case "get": {
      expectArgs(args, 2);
      const collection = collectionArg(first);
      const id = idArg(second);
      const doc = client.get(collection, id);
      if (!doc) {
        out(`${collection}/${id} not found`);
        return 1;
      }
      out(JSON.stringify({ collection, id, fields: doc.fields }, null, 2));
      return 0;
    }
    case "list": {
      expectArgs(args, 1);
      const collection = collectionArg(first);
      const docs = client.list(collection);
      for (const doc of docs) {
        const title = typeof doc.fields.title === "string" ? doc.fields.title : "";
        out(`${doc.id}\t${title}`);
      }
      out(`${docs.length} ${collection}`);
      return 0;
    }
    case "sync": {
      expectArgs(args, 0);
      const result = await client.sync();
      out(`pushed ${result.pushed}, pulled ${result.pulled}, applied ${result.applied}`);
      return 0;
    }
    case "status": {
      expectArgs(args, 0);
      const cursor = client.pullCursor();
      out(`node ${client.nodeId}`);
      out(`pending ${client.pendingCount()}`);
      out(`pulled up to ${cursor}`);
      if (ctx.server) {
        const remote = await ctx.server.status();
        out(`server at ${remote.latestSeq}: ${remote.latestSeq > cursor ? "changes to pull" : "up to date"}`);
      }
      return 0;
    }
    case "whoami": {
      expectArgs(args, 0);
      const me = await requireServer(ctx).me();
      out(`${me.user.displayName} <${me.user.email}>`);
      out(`device ${me.device.id} (${me.device.name})`);
      return 0;
    }
    case "add-device": {
      expectArgs(args, 1);
      if (first === undefined || first.trim() === "") throw new UsageError("a device name is required");
      const registered = await requireServer(ctx).registerDevice(first);
      out(`device ${registered.device.id} (${registered.device.name})`);
      out(`token ${registered.token}`);
      return 0;
    }
    default:
      throw new UsageError(args.command === null ? "a command is required" : `unknown command ${args.command}`);
  }
}
