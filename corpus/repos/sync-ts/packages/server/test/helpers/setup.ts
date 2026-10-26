import { afterAll, beforeEach } from "vitest";
import { closeConnections, resetState } from "./db.js";

// Every test file (server, client and shared) starts each test with an empty database.
beforeEach(async () => {
  await resetState();
});

afterAll(async () => {
  await closeConnections();
});
