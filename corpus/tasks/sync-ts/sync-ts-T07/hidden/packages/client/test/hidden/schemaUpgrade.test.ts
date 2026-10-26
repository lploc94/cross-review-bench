import { CLIENT_MIGRATIONS, CorruptStoreError, migrate, openDatabase, schemaVersion } from "@sync/client";
import { formatHlc } from "@sync/shared";
import { describe, expect, it } from "vitest";
import { openLocalClient } from "../helpers/clients.js";
import { tempDbPath } from "../helpers/tempFiles.js";

const at = (n: number) => formatHlc({ wallMs: 1_894_701_600_000 + n, counter: 0, node: "laptop" });

function tables(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function docRows(db: ReturnType<typeof openDatabase>): unknown[] {
  return db.prepare("SELECT collection, id, fields, field_hlcs FROM docs ORDER BY collection, id").all();
}

/** A replica written by a version 1 client; notes/b has a cut-off JSON value. */
function versionOneReplica(path: string): unknown[] {
  const db = openDatabase(path);
  migrate(db, CLIENT_MIGRATIONS.slice(0, 1));
  const insert = db.prepare("INSERT INTO docs (collection, id, fields, field_hlcs) VALUES (?, ?, ?, ?)");
  insert.run("notes", "a", JSON.stringify({ title: "Alpha", tags: ["x"] }), JSON.stringify({ title: at(1), tags: at(2) }));
  insert.run("notes", "b", '{"title": "Bravo", "body": "cut', JSON.stringify({ title: at(3), body: at(4) }));
  insert.run("notes", "c", JSON.stringify({ title: "Charlie" }), JSON.stringify({ title: at(5) }));
  insert.run("tasks", "t", JSON.stringify({ done: true, priority: 2 }), JSON.stringify({ done: at(6), priority: at(7) }));
  db.prepare("INSERT INTO meta (key, value) VALUES ('node_id', 'laptop')").run();
  db.prepare("INSERT INTO outbox (mutation_id, collection, doc_id, fields, hlc) VALUES (?, 'notes', 'c', ?, ?)").run(
    "00000000-0000-4000-8000-000000000001",
    JSON.stringify({ title: "Charlie" }),
    at(5),
  );
  const rows = docRows(db);
  db.close();
  return rows;
}

describe("upgrading a version 1 replica", () => {
  it("leaves the replica at version 1 when a row cannot be moved, and upgrades once it is repaired", async () => {
    const path = tempDbPath();
    const original = versionOneReplica(path);

    expect(() => openLocalClient({ dbPath: path })).toThrow(CorruptStoreError);
    const failed = openDatabase(path);
    expect(schemaVersion(failed)).toBe(1);
    expect(tables(failed)).toEqual(["docs", "meta", "outbox"]);
    expect(docRows(failed)).toEqual(original);
    failed.prepare("UPDATE docs SET fields = ? WHERE id = 'b'").run(JSON.stringify({ title: "Bravo", body: "cut" }));
    failed.close();

    const client = openLocalClient({ dbPath: path });
    expect(client.list("notes").map((doc) => [doc.id, doc.fields])).toEqual([
      ["a", { title: "Alpha", tags: ["x"] }],
      ["b", { title: "Bravo", body: "cut" }],
      ["c", { title: "Charlie" }],
    ]);
    expect(client.get("tasks", "t")?.fields).toEqual({ done: true, priority: 2 });
    expect(client.pendingCount()).toBe(1);
    await client.close();

    const upgraded = openDatabase(path);
    expect(schemaVersion(upgraded)).toBe(2);
    const count = upgraded.prepare<[], { n: number }>("SELECT count(*) AS n FROM doc_fields").get();
    expect(count?.n).toBe(7);
    upgraded.close();
  });

  it("opens the replica again after the migration failed at VACUUM", async () => {
    const path = tempDbPath();
    versionOneReplica(path);
    const db = openDatabase(path);
    db.prepare("UPDATE docs SET fields = ? WHERE id = 'b'").run(JSON.stringify({ title: "Bravo", body: "cut" }));
    // VACUUM needs about as much free disk space as the file itself; here the disk is full by then.
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql.trim() === "VACUUM") throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      return exec(sql);
    };
    expect(() => migrate(db)).toThrow(/disk is full/);
    db.close();

    const client = openLocalClient({ dbPath: path });
    expect(client.list("notes").map((doc) => [doc.id, doc.fields])).toEqual([
      ["a", { title: "Alpha", tags: ["x"] }],
      ["b", { title: "Bravo", body: "cut" }],
      ["c", { title: "Charlie" }],
    ]);
    expect(client.pendingCount()).toBe(1);
    await client.close();

    const upgraded = openDatabase(path);
    expect(schemaVersion(upgraded)).toBe(2);
    const count = upgraded.prepare<[], { n: number }>("SELECT count(*) AS n FROM doc_fields").get();
    expect(count?.n).toBe(7);
    upgraded.close();
  });
});
