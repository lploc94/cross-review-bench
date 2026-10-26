import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { StorageError } from "../../src/domain/errors.js";
import { MAX_PART_INDEX, type StorageDriver } from "../../src/storage/driver.js";
import { chunkedStream, collect, failingStream } from "../helpers/streams.js";

export interface DriverFixture {
  readonly driver: StorageDriver;
  close(): Promise<void>;
}

const tenantId = "8a1f2c3d-0000-4000-8000-000000000001";

function key(): string {
  return `t/${tenantId}/${randomUUID()}`;
}

/** The behaviour every storage driver shares, run against each of them. */
export function storageContract(name: string, setUp: () => Promise<DriverFixture>): void {
  describe(`${name} storage driver`, () => {
    let fixture: DriverFixture;
    let driver: StorageDriver;

    beforeEach(async () => {
      fixture = await setUp();
      driver = fixture.driver;
    });

    afterEach(async () => {
      await fixture.close();
    });

    it("stores, reads, heads and deletes an object", async () => {
      const target = key();
      const result = await driver.put(target, chunkedStream(["hello ", "world"]), {
        contentType: "text/plain",
      });
      expect(result.bytes).toBe(11);
      expect((await collect(await driver.get(target))).toString()).toBe("hello world");
      expect(await driver.head(target)).toEqual({ size: 11 });
      await driver.delete(target);
      expect(await driver.head(target)).toBeNull();
      await driver.delete(target);
    });

    it("reports a missing object as a not-found StorageError", async () => {
      const missing = key();
      const error = await driver.get(missing).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).isNotFound).toBe(true);
    });

    it("leaves nothing behind when the source stream fails", async () => {
      const target = key();
      const failure = new Error("client went away");
      await expect(
        driver.put(target, failingStream([Buffer.from("partial")], failure), { contentType: "text/plain" }),
      ).rejects.toBe(failure);
      expect(await driver.head(target)).toBeNull();
    });

    it("refuses a stream whose length differs from the declared size", async () => {
      const target = key();
      await expect(
        driver.put(target, chunkedStream(["four"]), { contentType: "text/plain", size: 5 }),
      ).rejects.toThrow();
      expect(await driver.head(target)).toBeNull();
    });

    it("copies an object", async () => {
      const source = key();
      const target = key();
      await driver.put(source, chunkedStream(["copy me"]), { contentType: "text/plain" });
      await driver.copy(source, target);
      expect((await collect(await driver.get(target))).toString()).toBe("copy me");
    });

    it("stages parts, replaces a retried part, and assembles them in order", async () => {
      const session = randomUUID();
      await driver.stagePart(session, 2, chunkedStream(["second;"]));
      await driver.stagePart(session, 1, chunkedStream(["first, failed attempt;"]));
      await driver.stagePart(session, 1, chunkedStream(["first;"]));
      await driver.stagePart(session, 3, chunkedStream(["third"]));
      const target = key();
      const result = await driver.assemble(session, target, 3);
      expect(result.bytes).toBe(18);
      expect((await collect(await driver.get(target))).toString()).toBe("first;second;third");
      expect(await driver.listStaging()).toEqual([session]);
      await driver.discardStaging(session);
      expect(await driver.listStaging()).toEqual([]);
      await driver.discardStaging(session);
    });

    it("fails to assemble when a part is missing, writing nothing", async () => {
      const session = randomUUID();
      await driver.stagePart(session, 1, chunkedStream(["only one"]));
      const target = key();
      const error = await driver.assemble(session, target, 2).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(StorageError);
      expect(await driver.head(target)).toBeNull();
    });

    it("refuses part indexes and session ids outside the allowed range", async () => {
      await expect(driver.stagePart(randomUUID(), 0, chunkedStream(["x"]))).rejects.toThrow(/part index/);
      await expect(
        driver.stagePart(randomUUID(), MAX_PART_INDEX + 1, chunkedStream(["x"])),
      ).rejects.toThrow(/part index/);
      await expect(driver.stagePart("../escape", 1, chunkedStream(["x"]))).rejects.toThrow(/session id/);
    });
  });
}
