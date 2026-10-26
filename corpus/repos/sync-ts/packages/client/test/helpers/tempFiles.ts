import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A path for a new SQLite file in a directory removed after the test. */
export function tempDbPath(name = "replica.sqlite"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sync-client-"));
  created.push(dir);
  return path.join(dir, name);
}
