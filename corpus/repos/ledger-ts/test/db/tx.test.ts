import { describe, expect, it } from "vitest";
import { withTransaction } from "../../src/db/tx.js";
import { testPool } from "../helpers/db.js";

async function tenantCount(): Promise<number> {
  const result = await testPool().query<{ count: string }>("SELECT count(*) AS count FROM tenants");
  return Number(result.rows[0]?.count);
}

describe("withTransaction", () => {
  it("commits when the callback resolves", async () => {
    const value = await withTransaction(testPool(), async (client) => {
      await client.query("INSERT INTO tenants (name) VALUES ('committed')");
      return 42;
    });
    expect(value).toBe(42);
    expect(await tenantCount()).toBe(1);
  });

  it("rolls back and rethrows when the callback throws", async () => {
    const failure = new Error("boom");
    await expect(
      withTransaction(testPool(), async (client) => {
        await client.query("INSERT INTO tenants (name) VALUES ('rolled back')");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await tenantCount()).toBe(0);
  });

  it("returns the client to the pool in every case", async () => {
    const pool = testPool();
    for (let i = 0; i < 3; i++) {
      await withTransaction(pool, async () => {
        throw new Error("fail");
      }).catch(() => undefined);
    }
    await withTransaction(pool, async () => undefined);
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });

  it("applies the requested isolation level", async () => {
    const level = await withTransaction(
      testPool(),
      async (client) => {
        const result = await client.query<{ transaction_isolation: string }>(
          "SHOW transaction_isolation",
        );
        return result.rows[0]?.transaction_isolation;
      },
      { isolation: "serializable" },
    );
    expect(level).toBe("serializable");
  });
});
