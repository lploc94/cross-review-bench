/** Connection string of the test database, provided by the environment. */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must point at an empty test database");
  return url;
}
