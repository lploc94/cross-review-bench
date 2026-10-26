import { describe, expect, it } from "vitest";
import { testPool } from "../helpers/db.js";

async function tenant(quota = 1000, used = 0): Promise<string> {
  const result = await testPool().query<{ id: string }>(
    "INSERT INTO tenants (name, quota_bytes, used_bytes, created_at) VALUES ('Lakeside Clinic', $1, $2, now()) RETURNING id",
    [quota, used],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("no tenant");
  return id;
}

async function file(tenantId: string, path: string, status = "pending_scan"): Promise<void> {
  await testPool().query(
    `INSERT INTO files (id, tenant_id, path, size, sha256, content_type, original_name, storage_driver,
       storage_key, status, next_scan_at, deleted_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, 1, repeat('a', 64), 'text/plain', 'a.txt', 'local',
       't/' || $1::text || '/' || gen_random_uuid(), $3::text,
       CASE WHEN $3::text = 'pending_scan' THEN now() END,
       CASE WHEN $3::text = 'deleted' THEN now() END, now(), now())`,
    [tenantId, path, status],
  );
}

describe("schema constraints", () => {
  it("keeps used bytes from going negative", async () => {
    await expect(tenant(1000, -1)).rejects.toThrow(/check constraint/);
  });

  it("allows one live file per path, any number of deleted ones", async () => {
    const id = await tenant();
    await file(id, "a.txt", "deleted");
    await file(id, "a.txt", "deleted");
    await file(id, "a.txt");
    await expect(file(id, "a.txt", "available")).rejects.toThrow(/files_tenant_path_live/);
    const other = await tenant();
    await file(other, "a.txt");
  });

  it("compares paths byte for byte", async () => {
    const id = await tenant();
    await file(id, "B.txt");
    await file(id, "a.txt");
    await file(id, "b.txt");
    const result = await testPool().query<{ path: string }>(
      "SELECT path FROM files WHERE tenant_id = $1 ORDER BY path",
      [id],
    );
    expect(result.rows.map((row) => row.path)).toEqual(["B.txt", "a.txt", "b.txt"]);
  });

  it("keeps an upload session's offset within its size", async () => {
    const id = await tenant();
    await expect(
      testPool().query(
        `INSERT INTO upload_sessions (id, tenant_id, path, size, offset_bytes, original_name, state,
           created_at, updated_at, expires_at)
         VALUES (gen_random_uuid(), $1, 'a.bin', 10, 11, 'a.bin', 'open', now(), now(), now() + interval '1 hour')`,
        [id],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
