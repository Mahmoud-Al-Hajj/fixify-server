import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
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

const UPDATE_STATUS_SQL = `UPDATE requests SET status = ?
   WHERE id = ? AND status = ?`;

const UPDATE_STATUS_MARK_RESPONDED_SQL = `UPDATE requests
   SET status = ?, responded_at = COALESCE(responded_at, CURRENT_TIMESTAMP(3))
   WHERE id = ? AND status = ?`;

export interface UpdateRequestStatusInput {
  id: string;
  fromStatus: RequestStatus;
  toStatus: RequestStatus;
  // Sets responded_at only if it is still NULL — it records the provider's
  // first response, so a later response never overwrites it.
  markResponded: boolean;
}

// Optimistic concurrency: the row changes only if it is still in the status
// the caller validated against. Returns false when another writer moved it
// first, so the caller can fail instead of overwriting that transition.
export async function updateRequestStatus(
  conn: PoolConnection,
  input: UpdateRequestStatusInput
): Promise<boolean> {
  const [result] = await conn.query<ResultSetHeader>(
    input.markResponded ? UPDATE_STATUS_MARK_RESPONDED_SQL : UPDATE_STATUS_SQL,
    [input.toStatus, input.id, input.fromStatus]
  );
  return result.affectedRows === 1;
}

const UPDATE_QUOTE_STATE_SQL = `UPDATE requests
   SET status = ?,
       price_status = ?,
       price = COALESCE(?, price),
       responded_at = IF(?, COALESCE(responded_at, CURRENT_TIMESTAMP(3)), responded_at)
   WHERE id = ? AND status = ? AND price_status = ? AND price <=> ?`;

export interface UpdateQuoteStateInput {
  id: string;
  fromStatus: RequestStatus;
  toStatus: RequestStatus;
  fromPriceStatus: PriceStatus;
  toPriceStatus: PriceStatus;
  // The price the caller validated against. Part of the guard because
  // price_status alone can come back to the same value (proposed -> declined
  // -> proposed at a new price) between the caller's read and this write.
  fromPrice: string | null;
  // DECIMAL(10,2) as a string; null leaves the stored price unchanged.
  newPrice: string | null;
  markResponded: boolean;
}

// Same optimistic-concurrency contract as updateRequestStatus: returns false
// when the row no longer matches what the caller validated against.
export async function updateQuoteState(
  conn: PoolConnection,
  input: UpdateQuoteStateInput
): Promise<boolean> {
  const [result] = await conn.query<ResultSetHeader>(UPDATE_QUOTE_STATE_SQL, [
    input.toStatus,
    input.toPriceStatus,
    input.newPrice,
    input.markResponded,
    input.id,
    input.fromStatus,
    input.fromPriceStatus,
    input.fromPrice,
  ]);
  return result.affectedRows === 1;
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
