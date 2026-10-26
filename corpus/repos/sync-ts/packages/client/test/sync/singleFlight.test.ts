import { describe, expect, it } from "vitest";
import { SingleFlight } from "../../src/sync/singleFlight.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SingleFlight", () => {
  it("shares the running task with later callers", async () => {
    const flight = new SingleFlight<number>();
    const gate = deferred<number>();
    let runs = 0;
    const task = () => {
      runs += 1;
      return gate.promise;
    };
    const first = flight.run(task);
    const second = flight.run(task);
    expect(second).toBe(first);
    gate.resolve(7);
    await expect(first).resolves.toBe(7);
    expect(runs).toBe(1);
    expect(flight.current).toBeNull();
  });

  it("starts a new run once the previous one failed", async () => {
    const flight = new SingleFlight<string>();
    await expect(flight.run(() => Promise.reject(new Error("first")))).rejects.toThrow("first");
    await expect(flight.run(() => Promise.resolve("second"))).resolves.toBe("second");
  });

  it("turns a task that throws synchronously into a rejected run", async () => {
    const flight = new SingleFlight<void>();
    await expect(
      flight.run(() => {
        throw new Error("sync throw");
      }),
    ).rejects.toThrow("sync throw");
    expect(flight.current).toBeNull();
  });
});
