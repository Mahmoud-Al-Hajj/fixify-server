import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "./pool";
import { formatMysqlDateTime } from "./format-datetime";
import type { RequestStatus } from "../constants/request-status";
import type { ServiceType } from "../constants/service-type";
import type { AiStatus } from "../constants/ai-status";
import type { PriceStatus } from "../constants/price-status";

// Beirut wall-clock, no offset. See pool.ts for the schema-wide convention.
export interface Request {
  id: string;
  customerId: string;
  providerId: string;
  categoryId: number;
  serviceType: ServiceType | null;
  description: string;
  addressText: string;
  requestedStart: string | null;
  estimatedDurationMinutes: number | null;
  isUrgent: boolean;
  status: RequestStatus;
  aiStatus: AiStatus;
  aiAnalysis: unknown;
  // DECIMAL comes back as a string from mysql2 (decimalNumbers is not set
  // in pool.ts) — deliberately not converted to number, since money must
  // never become a float. Format for display at the edge.
  price: string | null;
  priceStatus: PriceStatus;
  paidAt: string | null;
  createdAt: string;
  respondedAt: string | null;
  completedAt: string | null;
}

interface RequestRow extends RowDataPacket {
  id: string;
  customer_id: string;
  provider_id: string;
  category_id: number;
  service_type: string | null;
  description: string;
  address_text: string;
  requested_start: string | null;
  estimated_duration_minutes: number | null;
  is_urgent: number;
  status: string;
  ai_status: string;
  ai_analysis: unknown;
  price: string | null;
  price_status: string;
  paid_at: string | null;
  created_at: string;
  responded_at: string | null;
  completed_at: string | null;
}

const REQUEST_COLUMNS = `
  id, customer_id, provider_id, category_id, service_type,
  description, address_text, requested_start,
  estimated_duration_minutes, is_urgent, status, ai_status,
  ai_analysis, price, price_status, paid_at, created_at,
  responded_at, completed_at
`;

function mapRow(row: RequestRow): Request {
  return {
    id: row.id,
    customerId: row.customer_id,
    providerId: row.provider_id,
    categoryId: row.category_id,
    serviceType: row.service_type as ServiceType | null,
    description: row.description,
    addressText: row.address_text,
    requestedStart: formatMysqlDateTime(row.requested_start),
    estimatedDurationMinutes: row.estimated_duration_minutes,
    isUrgent: Boolean(row.is_urgent),
    status: row.status as RequestStatus,
    aiStatus: row.ai_status as AiStatus,
    aiAnalysis: row.ai_analysis,
    price: row.price,
    priceStatus: row.price_status as PriceStatus,
    paidAt: formatMysqlDateTime(row.paid_at),
    createdAt: formatMysqlDateTime(row.created_at),
    respondedAt: formatMysqlDateTime(row.responded_at),
    completedAt: formatMysqlDateTime(row.completed_at),
  };
}

export interface InsertRequestInput {
  id: string;
  customerId: string;
  providerId: string;
  categoryId: number;
  serviceType: ServiceType | null;
  description: string;
  addressText: string;
  // requestedStart is written through mysql2's write path, which is
  // unaffected by dateStrings and encodes using the Date's UTC getters
  // (timezone: "Z"). Build it with Date.UTC(...) so the stored digits are
  // the intended Beirut wall-clock time. A Date built from local
  // components will be shifted by the offset.
  requestedStart: Date | null;
  estimatedDurationMinutes: number | null;
  isUrgent: boolean;
}

export async function insertRequest(
  conn: PoolConnection,
  input: InsertRequestInput
): Promise<void> {
  await conn.query(
    `INSERT INTO requests (
       id, customer_id, provider_id, category_id, service_type,
       description, address_text, requested_start,
       estimated_duration_minutes, is_urgent
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.customerId,
      input.providerId,
      input.categoryId,
      input.serviceType,
      input.description,
      input.addressText,
      input.requestedStart,
      input.estimatedDurationMinutes,
      input.isUrgent,
    ]
  );
}

export async function findRequestById(id: string): Promise<Request | null> {
  const [rows] = await pool.query<RequestRow[]>(
    `SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`,
    [id]
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function listRequestsForCustomer(
  customerId: string
): Promise<Request[]> {
  const [rows] = await pool.query<RequestRow[]>(
    `SELECT ${REQUEST_COLUMNS} FROM requests
     WHERE customer_id = ? ORDER BY created_at DESC`,
    [customerId]
  );
  return rows.map(mapRow);
}

export async function listRequestsForProvider(
  providerId: string
): Promise<Request[]> {
  const [rows] = await pool.query<RequestRow[]>(
    `SELECT ${REQUEST_COLUMNS} FROM requests
     WHERE provider_id = ? ORDER BY created_at DESC`,
    [providerId]
  );
  return rows.map(mapRow);
}
