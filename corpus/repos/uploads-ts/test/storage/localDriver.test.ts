import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StorageError } from "../../src/domain/errors.js";
import { resolveInside } from "../../src/storage/localDriver.js";
import { temporaryLocalStorage } from "../helpers/app.js";
import { chunkedStream, failingStream } from "../helpers/streams.js";
import { storageContract } from "./contract.js";

storageContract("local", async () => {
  const local = await temporaryLocalStorage();
  return { driver: local.driver, close: local.remove };
});

describe("local storage specifics", () => {
  it("refuses keys that leave the storage root", () => {
    for (const key of ["../outside", "a/../../outside", "/etc/passwd", "", "a\0b", "."]) {
      expect(() => resolveInside("/srv/storage", key)).toThrow(StorageError);
    }
    expect(resolveInside("/srv/storage", "t/a/b")).toBe(path.resolve("/srv/storage/t/a/b"));
  });

  it("removes its temporary file when a write fails", async () => {
    const local = await temporaryLocalStorage();
    try {
      const key = "t/8a1f2c3d-0000-4000-8000-000000000001/9b2e3d4c-0000-4000-8000-000000000002";
      await expect(
        local.driver.put(key, failingStream([Buffer.from("abc")], new Error("broken")), {
          contentType: "text/plain",
        }),
      ).rejects.toThrow("broken");
      const directory = path.join(local.root, "objects", path.dirname(key));
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await local.remove();
    }
  });

  it("lists only session directories as staging", async () => {
    const local = await temporaryLocalStorage();
    try {
      const session = "1c2d3e4f-0000-4000-8000-000000000003";
      await local.driver.stagePart(session, 1, chunkedStream(["x"]));
      await writeFile(path.join(local.root, "staging", "stray-file"), "x");
      expect(await local.driver.listStaging()).toEqual([session]);
    } finally {
      await local.remove();
    }
  });
});
