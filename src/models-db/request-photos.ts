import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "./pool";
import { formatMysqlDateTime } from "./format-datetime";
import type { PhotoKind } from "../constants/photo-kind";

// A provider's job photo. url is the stored path relative to the uploads
// directory; it never leaves the server as is.
export interface RequestPhoto {
  id: string;
  kind: PhotoKind;
  url: string;
  createdAt: string;
}

interface RequestPhotoRow extends RowDataPacket {
  id: string;
  kind: string;
  url: string;
  created_at: string;
}

interface CountRow extends RowDataPacket {
  count: number;
}

export async function insertRequestPhotos(
  conn: PoolConnection,
  requestId: string,
  kind: PhotoKind,
  photos: ReadonlyArray<{ id: string; url: string }>
): Promise<void> {
  await conn.query(
    `INSERT INTO request_photos (id, request_id, url, kind) VALUES ?`,
    [photos.map(({ id, url }) => [id, requestId, url, kind])]
  );
}

// Inside the transaction that holds the request row's lock, so the count
// cannot change before the insert. Served by idx_photos_request_kind.
export async function countRequestPhotos(
  conn: PoolConnection,
  requestId: string
): Promise<number> {
  const [rows] = await conn.query<CountRow[]>(
    `SELECT COUNT(*) AS count FROM request_photos WHERE request_id = ?`,
    [requestId]
  );
  return rows[0]?.count ?? 0;
}

// Oldest first; ties broken by id so the order is stable. Served by
// idx_photos_request_kind.
export async function listRequestPhotos(
  requestId: string
): Promise<RequestPhoto[]> {
  const [rows] = await pool.query<RequestPhotoRow[]>(
    `SELECT id, kind, url, created_at FROM request_photos
     WHERE request_id = ? ORDER BY created_at, id`,
    [requestId]
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as PhotoKind,
    url: row.url,
    createdAt: formatMysqlDateTime(row.created_at),
  }));
}

// The photo's stored path, only if it belongs to the request. Served by the
// primary key.
export async function findRequestPhotoUrl(
  photoId: string,
  requestId: string
): Promise<string | null> {
  const [rows] = await pool.query<RequestPhotoRow[]>(
    `SELECT id, kind, url, created_at FROM request_photos
     WHERE id = ? AND request_id = ?`,
    [photoId, requestId]
  );
  return rows[0]?.url ?? null;
}
