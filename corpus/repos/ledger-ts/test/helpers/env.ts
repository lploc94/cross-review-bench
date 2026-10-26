/** Connection strings of the test database and Redis db, provided by the environment. */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must point at an empty test database");
  return url;
}

export function testRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL must point at a Redis db reserved for tests");
  return url;
}
