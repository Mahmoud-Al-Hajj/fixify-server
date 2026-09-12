import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
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

export interface UserCredentials {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  avatarUrl: string | null;
  passwordHash: string;
}

interface UserCredentialsRow extends RowDataPacket {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  avatar_url: string | null;
  password_hash: string;
}

interface PublicUserRow extends RowDataPacket {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  avatar_url: string | null;
  is_provider: number;
}

interface ResetTokenRow extends RowDataPacket {
  id: string;
  reset_expires_at: Date;
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

export async function findUserCredentialsByEmail(
  email: string
): Promise<UserCredentials | null> {
  const [rows] = await pool.query<UserCredentialsRow[]>(
    `SELECT id, full_name, email, phone, avatar_url, password_hash
     FROM users WHERE email = ?`,
    [email]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    passwordHash: row.password_hash,
  };
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

export async function setPasswordResetToken(
  email: string,
  tokenHash: string,
  expiresAt: Date
): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE users SET reset_token_hash = ?, reset_expires_at = ?
     WHERE email = ?`,
    [tokenHash, expiresAt, email]
  );
  return result.affectedRows > 0;
}

export async function findUserByResetTokenHash(
  tokenHash: string
): Promise<{ id: string; resetExpiresAt: Date } | null> {
  const [rows] = await pool.query<ResetTokenRow[]>(
    `SELECT id, reset_expires_at FROM users
     WHERE reset_token_hash = ? AND reset_expires_at > UTC_TIMESTAMP(3)`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, resetExpiresAt: row.reset_expires_at };
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
