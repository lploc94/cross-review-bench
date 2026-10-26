import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openClient, type TestClient } from "../helpers/clients.js";
import { startTestServer, type TestAccount, type TestServer } from "../helpers/testServer.js";

let server: TestServer;
let laptop: TestAccount;
let phone: TestAccount;
const opened: TestClient[] = [];

beforeEach(async () => {
  server = await startTestServer();
  laptop = await server.createUser("Ada");
  phone = await server.addDevice(laptop);
});

afterEach(async () => {
  for (const c of opened.splice(0)) await c.client.close();
  await server.close();
});

describe("a replica of some collections, pulling in small pages", () => {
  it("receives every event of its collections", async () => {
    const full = openClient(server, laptop);
    opened.push(full);
    for (let i = 1; i <= 7; i++) {
      full.client.set("notes", `n${i}`, { title: `Note ${i}` });
      if (i % 3 === 0) full.client.set("tasks", `t${i}`, { title: `Task ${i}` });
    }
    await full.client.sync();

    const notes = openClient(server, phone, { collections: ["notes"], pullLimit: 3 });
    opened.push(notes);
    const result = await notes.client.sync();
    expect(result.pulled).toBe(7);
    expect(notes.client.list("notes").map((doc) => doc.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
    expect(notes.client.list("tasks")).toEqual([]);
  });

  it("receives every event when a whole read of the feed is of its collections", async () => {
    const full = openClient(server, laptop);
    opened.push(full);
    for (let i = 1; i <= 5; i++) full.client.set("notes", `n${i}`, { title: `Note ${i}` });
    full.client.set("tasks", "t1", { title: "Task 1" });
    await full.client.sync();

    const notes = openClient(server, phone, { collections: ["notes"], pullLimit: 3 });
    opened.push(notes);
    const result = await notes.client.sync();
    expect(result.pulled).toBe(5);
    expect(notes.client.list("notes").map((doc) => doc.id)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
  });
});
