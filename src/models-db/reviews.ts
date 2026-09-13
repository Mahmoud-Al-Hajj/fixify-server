import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "./pool";
import { formatMysqlDateTime } from "./format-datetime";
import { ConflictError } from "../constants/errors";
import type { RequestStatus } from "../constants/request-status";

export interface Review {
  id: string;
  requestId: string;
  rating: number;
  comment: string | null;
  createdAt: string;
}

export interface RatingSummary {
  average: number | null;
  count: number;
}

interface ReviewRow extends RowDataPacket {
  id: string;
  request_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

interface RatingSummaryRow extends RowDataPacket {
  provider_id: string;
  review_count: number;
  // ROUND(AVG(...)) is DECIMAL, which mysql2 returns as a string.
  average_rating: string | null;
}

function mapReviewRow(row: ReviewRow): Review {
  return {
    id: row.id,
    requestId: row.request_id,
    rating: row.rating,
    comment: row.comment,
    createdAt: formatMysqlDateTime(row.created_at),
  };
}

// The message trg_reviews_completed signals with (schema.sql).
const NOT_COMPLETED_SIGNAL = "Review allowed only on completed requests";
const ONE_REVIEW_KEY = "uq_reviews_request";

function driverError(err: unknown): { code: unknown; message: string } | null {
  return err instanceof Error && "code" in err
    ? { code: err.code, message: err.message }
    : null;
}

export interface InsertReviewInput {
  id: string;
  requestId: string;
  rating: number;
  comment: string | null;
}

// The database is the guarantee for both rules: the trigger rejects a review
// on a request that isn't completed, and the unique key allows one per
// request. There is no check-then-insert, which would race.
export async function insertReview(
  conn: PoolConnection,
  input: InsertReviewInput
): Promise<void> {
  try {
    await conn.query(
      `INSERT INTO reviews (id, request_id, rating, comment) VALUES (?, ?, ?, ?)`,
      [input.id, input.requestId, input.rating, input.comment]
    );
  } catch (err) {
    const e = driverError(err);
    if (
      e?.code === "ER_SIGNAL_EXCEPTION" &&
      e.message.includes(NOT_COMPLETED_SIGNAL)
    ) {
      throw new ConflictError("Reviews can only be left on completed requests");
    }
    if (e?.code === "ER_DUP_ENTRY" && e.message.includes(ONE_REVIEW_KEY)) {
      throw new ConflictError("This request has already been reviewed");
    }
    throw err;
  }
}

// Served by uq_reviews_request (request_id).
export async function findReviewForRequest(
  requestId: string
): Promise<Review | null> {
  const [rows] = await pool.query<ReviewRow[]>(
    `SELECT id, request_id, rating, comment, created_at
     FROM reviews WHERE request_id = ?`,
    [requestId]
  );
  const row = rows[0];
  return row ? mapReviewRow(row) : null;
}

// One query for any number of providers. Reviews reach a provider through
// their completed requests: served by idx_req_provider_status
// (provider_id, status) and then uq_reviews_request.
export async function findRatingSummariesForProviders(
  providerIds: readonly string[],
  completedStatus: RequestStatus
): Promise<Map<string, RatingSummary>> {
  const summaries = new Map<string, RatingSummary>();
  if (providerIds.length === 0) return summaries;
  const [rows] = await pool.query<RatingSummaryRow[]>(
    `SELECT r.provider_id, COUNT(rv.id) AS review_count,
            ROUND(AVG(rv.rating), 2) AS average_rating
     FROM requests r
     JOIN reviews rv ON rv.request_id = r.id
     WHERE r.provider_id IN (?) AND r.status = ?
     GROUP BY r.provider_id`,
    [providerIds, completedStatus]
  );
  for (const row of rows) {
    summaries.set(row.provider_id, {
      average: row.average_rating === null ? null : Number(row.average_rating),
      count: Number(row.review_count),
    });
  }
  return summaries;
}

export async function listRecentReviewsForProvider(
  providerId: string,
  completedStatus: RequestStatus,
  limit: number
): Promise<Review[]> {
  const [rows] = await pool.query<ReviewRow[]>(
    `SELECT rv.id, rv.request_id, rv.rating, rv.comment, rv.created_at
     FROM requests r
     JOIN reviews rv ON rv.request_id = r.id
     WHERE r.provider_id = ? AND r.status = ?
     ORDER BY rv.created_at DESC, rv.id
     LIMIT ?`,
    [providerId, completedStatus, limit]
  );
  return rows.map(mapReviewRow);
}
