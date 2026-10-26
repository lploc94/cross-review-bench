import type { Config } from "../config/env.js";
import type { Clock } from "../infra/clock.js";
import type { StorageDriver } from "./driver.js";
import { LocalStorageDriver } from "./localDriver.js";
import { S3Client } from "./s3Client.js";
import { S3StorageDriver } from "./s3Driver.js";

/** The storage driver the configuration names, ready to use. */
export async function createStorageDriver(
  config: Config["storage"],
  clock: Clock,
): Promise<StorageDriver> {
  switch (config.driver) {
    case "local": {
      const driver = new LocalStorageDriver({ root: config.localRoot });
      await driver.init();
      return driver;
    }
    case "s3": {
      if (!config.s3) throw new Error("STORAGE_DRIVER=s3 needs the S3_* settings");
      const client = new S3Client({
        endpoint: config.s3.endpoint,
        region: config.s3.region,
        bucket: config.s3.bucket,
        credentials: {
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
        },
        requestTimeoutMs: config.s3.requestTimeoutMs,
        clock,
      });
      return new S3StorageDriver({ client });
    }
  }
}
