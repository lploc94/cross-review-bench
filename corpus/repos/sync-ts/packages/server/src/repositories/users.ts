import type { Queryable } from "../db/pool.js";
import type { User } from "../domain/accounts.js";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: Date;
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at };
}

const COLUMNS = "id, email, display_name, created_at";

/** Insert a user; a duplicate email fails with a unique violation on users_email_key. */
export async function insertUser(db: Queryable, user: User): Promise<void> {
  await db.query("INSERT INTO users (id, email, display_name, created_at) VALUES ($1, $2, $3, $4)", [
    user.id,
    user.email,
    user.displayName,
    user.createdAt,
  ]);
}

export async function findUserById(db: Queryable, id: string): Promise<User | null> {
  const result = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toUser(row) : null;
}

export async function findUserByEmail(db: Queryable, email: string): Promise<User | null> {
  const result = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [email]);
  const row = result.rows[0];
  return row ? toUser(row) : null;
}

/**
 * Lock the user's row until the end of the transaction. Writes of one user (pushes, device
 * registrations) take this lock first, so they run one at a time per user.
 */
export async function lockUser(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [id]);
  return (result.rowCount ?? 0) > 0;
}
