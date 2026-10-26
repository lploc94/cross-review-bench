import { describe, expect, it } from "vitest";
import { UsageError, parseArgs } from "../../src/cli/args.js";
import { parseAssignments } from "../../src/cli/fieldValues.js";
import { EXIT_TEMPORARY_FAILURE, main } from "../../src/cli/main.js";
import { tempDbPath } from "../helpers/tempFiles.js";

describe("parseArgs", () => {
  it("separates the command, its arguments and the options", () => {
    const args = parseArgs(["--db", "a.sqlite", "set", "notes", "n1", "--token=sd_x", "title=Hi"]);
    expect(args.command).toBe("set");
    expect(args.positionals).toEqual(["notes", "n1", "title=Hi"]);
    expect(Object.fromEntries(args.options)).toEqual({ db: "a.sqlite", token: "sd_x" });
  });

  it("treats everything after -- as arguments", () => {
    expect(parseArgs(["set", "--", "--db"]).positionals).toEqual(["--db"]);
  });

  it.each([
    [["--colour", "red"], /unknown option --colour/],
    [["sync", "--db"], /--db needs a value/],
    [["sync", "--db", "--token", "x"], /--db needs a value/],
    [["sync", "--db="], /--db needs a value/],
    [["--db", "a", "--db", "b"], /--db given twice/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("parseAssignments", () => {
  it("converts values by field kind", () => {
    expect(parseAssignments("tasks", ["title=Call", "done=true", "priority=2", "dueDate=null", "noteId=n1"])).toEqual({
      title: "Call",
      done: true,
      priority: 2,
      dueDate: null,
      noteId: "n1",
    });
    expect(parseAssignments("notes", ["tags=a, b", "body=x=y"])).toEqual({ tags: ["a", "b"], body: "x=y" });
    expect(parseAssignments("notes", ["tags="])).toEqual({ tags: [] });
  });

  it.each([
    [[], /at least one/],
    [["title"], /expected field=value/],
    [["=x"], /expected field=value/],
    [["owner=me"], /has no field owner/],
    [["pinned=yes"], /true or false/],
    [["title=a", "title=b"], /set twice/],
    [["constructor=x"], /has no field constructor/],
  ])("rejects %j", (assignments, message) => {
    expect(() => parseAssignments("notes", assignments)).toThrow(message);
  });

  it("rejects integers that are not integers", () => {
    expect(() => parseAssignments("tasks", ["priority=1.5"])).toThrow(UsageError);
  });
});

describe("the command-line client", () => {
  async function run(argv: string[], env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("writes, reads and lists documents in the local replica", async () => {
    const env = { SYNC_DB: tempDbPath() };
    expect((await run(["set", "notes", "n1", "title=Groceries", "tags=home,weekly"], env)).code).toBe(0);
    expect((await run(["set", "notes", "n2", "title=Ideas"], env)).out).toMatch(/2 pending/);

    const got = await run(["get", "notes", "n1"], env);
    expect(got.code).toBe(0);
    expect(JSON.parse(got.out)).toEqual({ collection: "notes", id: "n1", fields: { title: "Groceries", tags: ["home", "weekly"] } });

    expect((await run(["list", "notes"], env)).out).toBe("n1\tGroceries\nn2\tIdeas\n2 notes");
    expect(await run(["get", "notes", "n9"], env)).toMatchObject({ code: 1, out: "notes/n9 not found" });
    expect((await run(["status"], env)).out).toMatch(/pending 2\npulled up to 0/);
  });

  it("answers usage errors with code 2 and the usage text", async () => {
    const env = { SYNC_DB: tempDbPath() };
    expect((await run([], env)).code).toBe(2);
    expect((await run(["help"], env)).code).toBe(0);
    const unknown = await run(["frobnicate"], env);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/unknown command frobnicate[\s\S]*usage: sync-cli/);
    expect((await run(["get", "contacts", "c1"], env)).code).toBe(2);
    expect((await run(["whoami"], env)).err).toMatch(/needs a server/);
    expect((await run(["status"], { SYNC_TIMEOUT_MS: "0" })).code).toBe(2);
  });

  it("reports an invalid value with the mutation error", async () => {
    const result = await run(["set", "tasks", "t1", "priority=7"], { SYNC_DB: tempDbPath() });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^invalid_mutation: /);
  });

  it("explains that sync needs a server", async () => {
    const result = await run(["sync"], { SYNC_DB: tempDbPath() });
    expect(result).toMatchObject({ code: 1 });
    expect(result.err).toMatch(/server_not_configured/);
  });

  it("exits 75 when the server cannot be reached", async () => {
    const result = await run(["sync"], {
      SYNC_DB: tempDbPath(),
      SYNC_SERVER_URL: "http://127.0.0.1:9",
      SYNC_TOKEN: "sd_x",
      SYNC_TIMEOUT_MS: "2000",
    });
    expect(result.code).toBe(EXIT_TEMPORARY_FAILURE);
    expect(result.err).toMatch(/^network_error: /);
  });
});
