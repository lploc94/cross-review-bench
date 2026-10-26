import { IN_MEMORY, SyncClient, type SyncClientOptions, type SyncTransport } from "@sync/client";
import { ManualClock, seededRandom, type PullResponse, type PushResponse } from "@sync/shared";
import { InjectTransport } from "./injectTransport.js";
import type { TestAccount, TestServer } from "./testServer.js";

export interface TestClient {
  readonly client: SyncClient;
  readonly transport: InjectTransport;
  readonly clock: ManualClock;
}

let seed = 0;

/**
 * A client of the test server with its own manual clock (starting at the server's time) and a
 * seeded random source, in memory unless `dbPath` is given.
 */
export function openClient(
  server: TestServer,
  account: TestAccount,
  options: Partial<Omit<SyncClientOptions, "transport" | "clock">> & { clock?: ManualClock } = {},
): TestClient {
  const clock = options.clock ?? new ManualClock(server.clock.now());
  const transport = new InjectTransport(server.app, account.token);
  seed += 1;
  const client = SyncClient.open({
    dbPath: IN_MEMORY,
    random: seededRandom(seed),
    ...options,
    transport,
    clock,
  });
  return { client, transport, clock };
}

/** A transport for tests that never reach a server: every call fails the test. */
export const unreachableTransport: SyncTransport = {
  push: (): Promise<PushResponse> => Promise.reject(new Error("this test does not sync")),
  pull: (): Promise<PullResponse> => Promise.reject(new Error("this test does not sync")),
};

/** A client without a server, for tests of local behaviour. */
export function openLocalClient(options: Partial<SyncClientOptions> = {}): SyncClient {
  seed += 1;
  return SyncClient.open({
    dbPath: IN_MEMORY,
    transport: unreachableTransport,
    clock: new ManualClock(),
    random: seededRandom(seed),
    ...options,
  });
}

/** A transport that answers from a script: each call takes the next answer (or error). */
export class ScriptedTransport implements SyncTransport {
  readonly pushes: unknown[] = [];
  readonly pulls: { after: number; limit: number }[] = [];
  private readonly pushAnswers: (PushResponse | Error)[] = [];
  private readonly pullAnswers: (PullResponse | Error)[] = [];

  answerPush(...answers: (PushResponse | Error)[]): this {
    this.pushAnswers.push(...answers);
    return this;
  }

  answerPull(...answers: (PullResponse | Error)[]): this {
    this.pullAnswers.push(...answers);
    return this;
  }

  async push(request: { mutations: unknown[] }): Promise<PushResponse> {
    this.pushes.push(request);
    return this.next(this.pushAnswers, "push");
  }

  async pull(request: { after: number; limit: number }): Promise<PullResponse> {
    this.pulls.push(request);
    return this.next(this.pullAnswers, "pull");
  }

  private next<T>(answers: (T | Error)[], what: string): T {
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`no scripted ${what} answer left`);
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
