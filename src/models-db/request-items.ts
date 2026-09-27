import type { RowDataPacket } from "mysql2/promise";
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

// Served by fk_ri_request (request_id).
export async function listRequestItems(
  requestId: string
): Promise<RequestItem[]> {
  const [rows] = await pool.query<RequestItemRow[]>(
    `SELECT id, name, quantity, unit, estimated_unit_price, source
     FROM request_items WHERE request_id = ? ORDER BY created_at, id`,
    [requestId]
  );
  return rows.map(mapRow);
}
