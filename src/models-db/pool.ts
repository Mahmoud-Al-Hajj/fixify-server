import mysql, { type PoolConnection } from "mysql2/promise";
import { env } from "../config/env";

// Every DATETIME column in this schema is Beirut wall-clock time stored
// with no offset — written and read as plain digits, never as a UTC
// instant. reset_expires_at is the one exception: it is written from
// Date.now() (a true UTC instant) and compared in SQL against
// UTC_TIMESTAMP(3). dateStrings:true returns every DATETIME/TIMESTAMP as
// a raw string on read, for both kinds of column alike — the distinction
// above is a fact about what the digits mean, not something the driver
// or the type system enforces. timezone:"Z" now only matters for writes
// (e.g. reset_expires_at's expiry Date): it encodes an outgoing Date
// using its own UTC getters, which is correct for a true-UTC value and
// must not be changed without re-checking that column specifically.
export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
  timezone: "Z",
});

export async function assertDbReachable(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

// Runs work on one connection inside a transaction: commits if it resolves,
// rolls back and rethrows if it throws.
export async function withTransaction<T>(
  work: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }
}

// A driver error with this code whose message names the given key,
// constraint or trigger message.
export function isDbError(err: unknown, code: string, text: string): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    err.code === code &&
    err.message.includes(text)
  );
}
