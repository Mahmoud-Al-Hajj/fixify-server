import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { pool, isDbError } from "./pool";
import { formatMysqlDateTime } from "./format-datetime";
import type { RequestStatus } from "../constants/request-status";
import { ConflictError, ERROR_CODE } from "../constants/errors";
import type { ServiceType } from "../constants/service-type";
import type { PriceStatus } from "../constants/price-status";

// Beirut wall-clock, no offset. See pool.ts for the schema-wide convention.
// providerPhone lets the customer's app call the assigned provider. The
// customer's own phone is never selected here.
export interface Request {
  id: string;
  customerId: string;
  providerId: string;
  providerPhone: string;
  categoryId: number;
  intakeSessionId: string | null;
  serviceType: ServiceType | null;
  description: string;
  addressText: string;
  requestedStart: string | null;
  estimatedDurationMinutes: number | null;
  isUrgent: boolean;
  status: RequestStatus;
  // DECIMAL comes back as a string from mysql2 (decimalNumbers is not set
  // in pool.ts) — deliberately not converted to number, since money must
  // never become a float. Format for display at the edge.
  price: string | null;
  // A revised quote awaiting the customer while the job is in progress.
  revisedPrice: string | null;
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
  provider_phone: string;
  category_id: number;
  intake_session_id: string | null;
  service_type: string | null;
  description: string;
  address_text: string;
  requested_start: string | null;
  estimated_duration_minutes: number | null;
  is_urgent: number;
  status: string;
  price: string | null;
  revised_price: string | null;
  price_status: string;
  paid_at: string | null;
  created_at: string;
  responded_at: string | null;
  completed_at: string | null;
}

// provider_phone is looked up by primary key for each row.
const REQUEST_COLUMNS = `
  id, customer_id, provider_id,
  (SELECT phone FROM users WHERE users.id = requests.provider_id) AS provider_phone,
  category_id, intake_session_id,
  service_type, description, address_text, requested_start,
  estimated_duration_minutes, is_urgent, status, price, revised_price, price_status,
  paid_at, created_at, responded_at, completed_at
`;

function mapRow(row: RequestRow): Request {
  return {
    id: row.id,
    customerId: row.customer_id,
    providerId: row.provider_id,
    providerPhone: row.provider_phone,
    categoryId: row.category_id,
    intakeSessionId: row.intake_session_id,
    serviceType: row.service_type as ServiceType | null,
    description: row.description,
    addressText: row.address_text,
    requestedStart: formatMysqlDateTime(row.requested_start),
    estimatedDurationMinutes: row.estimated_duration_minutes,
    isUrgent: Boolean(row.is_urgent),
    status: row.status as RequestStatus,
    price: row.price,
    revisedPrice: row.revised_price,
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
  intakeSessionId: string | null;
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

const ONE_REQUEST_PER_SESSION_KEY = "uq_req_intake_session";

// The unique key backs the booking's under-lock check: a session becomes at
// most one request.
export async function insertRequest(
  conn: PoolConnection,
  input: InsertRequestInput
): Promise<void> {
  try {
    await conn.query(
      `INSERT INTO requests (
         id, customer_id, provider_id, category_id, intake_session_id,
         service_type, description, address_text, requested_start,
         estimated_duration_minutes, is_urgent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.customerId,
        input.providerId,
        input.categoryId,
        input.intakeSessionId,
        input.serviceType,
        input.description,
        input.addressText,
        input.requestedStart,
        input.estimatedDurationMinutes,
        input.isUrgent,
      ]
    );
  } catch (err) {
    if (isDbError(err, "ER_DUP_ENTRY", ONE_REQUEST_PER_SESSION_KEY)) {
      throw new ConflictError(
        "This problem has already been booked; describe a new one in a new session",
        ERROR_CODE.SESSION_ALREADY_BOOKED
      );
    }
    throw err;
  }
}

const UPDATE_STATUS_SQL = `UPDATE requests
   SET status = ?,
       responded_at = IF(?, COALESCE(responded_at, CURRENT_TIMESTAMP(3)), responded_at),
       completed_at = IF(?, CURRENT_TIMESTAMP(3), completed_at)
   WHERE id = ? AND status = ?
     -- requireNoRevision: only completion sets it, so a job never closes over an unanswered revised quote
     AND (? = 0 OR revised_price IS NULL)`;

export interface UpdateRequestStatusInput {
  id: string;
  fromStatus: RequestStatus;
  toStatus: RequestStatus;
  // Sets responded_at only if it is still NULL — it records the provider's
  // first response, so a later response never overwrites it.
  markResponded: boolean;
  markCompleted: boolean;
  requireNoRevision: boolean;
}

// Locks the request row for the rest of the transaction and returns its
// current status. Must be the transaction's first read (see "Double-booking"
// in CLAUDE.md for why).
export async function lockRequestForUpdate(
  conn: PoolConnection,
  id: string
): Promise<RequestStatus | null> {
  const [rows] = await conn.query<RequestRow[]>(
    `SELECT status FROM requests WHERE id = ? FOR UPDATE`,
    [id]
  );
  const row = rows[0];
  return row ? (row.status as RequestStatus) : null;
}

// Optimistic concurrency: the row changes only if it is still in the status
// the caller validated against. Returns false when another writer moved it
// first, so the caller can fail instead of overwriting that transition.
export async function updateRequestStatus(
  conn: PoolConnection,
  input: UpdateRequestStatusInput
): Promise<boolean> {
  const [result] = await conn.query<ResultSetHeader>(UPDATE_STATUS_SQL, [
    input.toStatus,
    input.markResponded,
    input.markCompleted,
    input.id,
    input.fromStatus,
    input.requireNoRevision,
  ]);
  return result.affectedRows === 1;
}

// One guarded statement: it applies only if the request is still in the
// required status and not yet paid, so a concurrent mark-paid can't write
// paid_at twice. Returns false when the guard no longer matches.
export async function markRequestPaid(
  conn: PoolConnection,
  id: string,
  requiredStatus: RequestStatus
): Promise<boolean> {
  const [result] = await conn.query<ResultSetHeader>(
    `UPDATE requests SET paid_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = ? AND paid_at IS NULL`,
    [id, requiredStatus]
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

// A revision move on an in-progress job. applyRevision copies revised_price
// into price (the customer accepted it) before revised_price is overwritten;
// single-table SET assignments run left to right. Same optimistic guard as
// updateQuoteState: false when the row no longer matches.
export async function updateRevisedQuote(
  conn: PoolConnection,
  input: {
    id: string;
    status: RequestStatus;
    fromPriceStatus: PriceStatus;
    toPriceStatus: PriceStatus;
    fromRevisedPrice: string | null;
    newRevisedPrice: string | null;
    applyRevision: boolean;
  }
): Promise<boolean> {
  const [result] = await conn.query<ResultSetHeader>(
    `UPDATE requests
     SET price_status = ?, price = IF(?, revised_price, price), revised_price = ?
     WHERE id = ? AND status = ? AND price_status = ? AND revised_price <=> ?`,
    [
      input.toPriceStatus,
      input.applyRevision,
      input.newRevisedPrice,
      input.id,
      input.status,
      input.fromPriceStatus,
      input.fromRevisedPrice,
    ]
  );
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
