import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "./pool";
import type { ItemSource } from "../constants/item-source";

// A part or material the provider needs for a job. estimatedUnitPrice is
// DECIMAL(10,2) carried as a string, like requests.price.
export interface RequestItem {
  id: string;
  name: string;
  quantity: number;
  unit: string | null;
  estimatedUnitPrice: string | null;
  source: ItemSource;
}

interface RequestItemRow extends RowDataPacket {
  id: string;
  name: string;
  quantity: number;
  unit: string | null;
  estimated_unit_price: string | null;
  source: string;
}

function mapRow(row: RequestItemRow): RequestItem {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    estimatedUnitPrice: row.estimated_unit_price,
    source: row.source as ItemSource,
  };
}

// The list in the provider's order. Served by fk_ri_request (request_id); the
// sort is over one request's few rows. Pass the transaction's connection
// when reading inside one.
export async function listRequestItems(
  requestId: string,
  db: Pool | PoolConnection = pool
): Promise<RequestItem[]> {
  const [rows] = await db.query<RequestItemRow[]>(
    `SELECT id, name, quantity, unit, estimated_unit_price, source
     FROM request_items WHERE request_id = ? ORDER BY sort_order, id`,
    [requestId]
  );
  return rows.map(mapRow);
}

export async function insertRequestItems(
  conn: PoolConnection,
  requestId: string,
  items: readonly RequestItem[]
): Promise<void> {
  if (items.length === 0) return;
  await conn.query(
    `INSERT INTO request_items
       (id, request_id, name, quantity, unit, estimated_unit_price, source,
        sort_order)
     VALUES ?`,
    [
      items.map((i, index) => [
        i.id,
        requestId,
        i.name,
        i.quantity,
        i.unit,
        i.estimatedUnitPrice,
        i.source,
        index,
      ]),
    ]
  );
}

export async function updateRequestItem(
  conn: PoolConnection,
  item: RequestItem
): Promise<void> {
  await conn.query(
    `UPDATE request_items
     SET name = ?, quantity = ?, unit = ?, estimated_unit_price = ?, source = ?
     WHERE id = ?`,
    [
      item.name,
      item.quantity,
      item.unit,
      item.estimatedUnitPrice,
      item.source,
      item.id,
    ]
  );
}

// Puts the request's items in the given order (a save's final list). A row
// whose position is unchanged is not touched.
export async function setRequestItemOrder(
  conn: PoolConnection,
  requestId: string,
  orderedIds: readonly string[]
): Promise<void> {
  if (orderedIds.length === 0) return;
  await conn.query(
    `UPDATE request_items SET sort_order = FIELD(id, ?) - 1
     WHERE request_id = ? AND id IN (?)`,
    [orderedIds, requestId, orderedIds]
  );
}

export async function deleteRequestItems(
  conn: PoolConnection,
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) return;
  await conn.query(`DELETE FROM request_items WHERE id IN (?)`, [ids]);
}
