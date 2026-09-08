import mysql from "mysql2/promise";
import { env } from "../config/env";

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  dateStrings: false,
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
