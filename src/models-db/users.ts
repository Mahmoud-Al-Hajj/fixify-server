import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { PoolConnection } from "mysql2/promise";
import { pool } from "./pool";

export interface PublicUser {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  avatarUrl: string | null;
  isProvider: boolean;
}

interface PublicUserRow extends RowDataPacket {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  avatar_url: string | null;
  is_provider: number;
}

export async function insertUser(
  conn: PoolConnection,
  input: {
    id: string;
    fullName: string;
    email: string;
    phone: string;
    passwordHash: string;
  }
): Promise<void> {
  await conn.query(
    `INSERT INTO users (id, full_name, email, phone, password_hash)
     VALUES (?, ?, ?, ?, ?)`,
    [input.id, input.fullName, input.email, input.phone, input.passwordHash]
  );
}

interface CredentialsRow extends RowDataPacket {
  id: string;
  password_hash: string;
}

export async function findUserCredentialsByEmail(
  email: string
): Promise<{ id: string; passwordHash: string } | null> {
  const [rows] = await pool.query<CredentialsRow[]>(
    `SELECT id, password_hash FROM users WHERE email = ?`,
    [email]
  );
  const row = rows[0];
  return row ? { id: row.id, passwordHash: row.password_hash } : null;
}

export async function findPublicUserById(
  id: string
): Promise<PublicUser | null> {
  const [rows] = await pool.query<PublicUserRow[]>(
    `SELECT u.id, u.full_name, u.email, u.phone, u.avatar_url,
            (p.id IS NOT NULL) AS is_provider
     FROM users u
     LEFT JOIN providers p ON p.id = u.id
     WHERE u.id = ?`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    isProvider: Boolean(row.is_provider),
  };
}

interface PasswordHashRow extends RowDataPacket {
  password_hash: string;
}

// Returns the bare hash for verification only. Deliberately not part of any
// user object, so it can't be carried into a response by accident.
export async function findPasswordHashById(id: string): Promise<string | null> {
  const [rows] = await pool.query<PasswordHashRow[]>(
    `SELECT password_hash FROM users WHERE id = ?`,
    [id]
  );
  return rows[0]?.password_hash ?? null;
}

export interface UserProfileChanges {
  fullName?: string;
  phone?: string;
}

// Only the fixed fragments below ever become SQL; every value is a parameter.
const PROFILE_CHANGE_FRAGMENTS: ReadonlyArray<
  [keyof UserProfileChanges, string]
> = [
  ["fullName", "full_name = ?"],
  ["phone", "phone = ?"],
];

export async function updateUserProfile(
  id: string,
  changes: UserProfileChanges
): Promise<void> {
  const fragments: string[] = [];
  const values: string[] = [];
  for (const [field, fragment] of PROFILE_CHANGE_FRAGMENTS) {
    const value = changes[field];
    if (value !== undefined) {
      fragments.push(fragment);
      values.push(value);
    }
  }
  if (fragments.length === 0) return;
  await pool.query(`UPDATE users SET ${fragments.join(", ")} WHERE id = ?`, [
    ...values,
    id,
  ]);
}

export async function setPasswordResetToken(
  email: string,
  tokenHash: string,
  expiresAt: Date
): Promise<void> {
  await pool.query(
    `UPDATE users SET reset_token_hash = ?, reset_expires_at = ?
     WHERE email = ?`,
    [tokenHash, expiresAt, email]
  );
}

// Sets the new password only if the token is still stored and unexpired, and
// clears it in the same statement, so a token works once even under
// concurrent use. Returns false when no row matched.
export async function resetPasswordWithToken(
  tokenHash: string,
  passwordHash: string
): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE users
     SET password_hash = ?, reset_token_hash = NULL, reset_expires_at = NULL
     WHERE reset_token_hash = ? AND reset_expires_at > UTC_TIMESTAMP(3)`,
    [passwordHash, tokenHash]
  );
  return result.affectedRows === 1;
}

export async function updatePasswordAndClearResetToken(
  id: string,
  passwordHash: string
): Promise<void> {
  await pool.query(
    `UPDATE users
     SET password_hash = ?, reset_token_hash = NULL, reset_expires_at = NULL
     WHERE id = ?`,
    [passwordHash, id]
  );
}

// Marks the user's notifications read up to `upTo`, capped at MySQL's own
// clock (a client clock that runs fast cannot mark future events read) and
// never earlier than the stored value (a stale call cannot make read events
// unread again). Every DATETIME here is Beirut wall-clock, as created_at is.
export async function markNotificationsReadUpTo(
  id: string,
  upTo: Date
): Promise<void> {
  await pool.query(
    `UPDATE users
     SET notifications_read_at = GREATEST(
       COALESCE(notifications_read_at, '1000-01-01'),
       LEAST(?, CURRENT_TIMESTAMP(3)))
     WHERE id = ?`,
    [upTo, id]
  );
}
