import { afterAll, beforeEach } from "vitest";
import { closeConnections, resetState } from "./db.js";

beforeEach(async () => {
  await resetState();
});

afterAll(async () => {
  await closeConnections();
});
