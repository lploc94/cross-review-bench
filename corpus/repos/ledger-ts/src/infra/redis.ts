import { Redis } from "ioredis";
import type { Logger } from "./logger.js";

export type { Redis };

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    lazyConnect: false,
  });
  redis.on("error", (err: Error) => {
    logger.error({ err }, "redis connection error");
  });
  return redis;
}

/** Close the connection, waiting for pending replies; fall back to disconnecting. */
export async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === "end") return;
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
