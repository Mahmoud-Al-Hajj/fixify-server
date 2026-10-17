import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "./pool";
import type { Category } from "./categories";

// Provider fields shown in search results: no contact details.
export interface ProviderSummary {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  area: string | null;
  yearsExperience: number | null;
  isAccepting: boolean;
}

// The profile adds the phone number, the one contact detail shared across
// roles, so the customer's app can place the call. Never the email.
export interface ProviderProfile extends ProviderSummary {
  bio: string | null;
  phone: string;
}

interface ProviderSummaryRow extends RowDataPacket {
  id: string;
  full_name: string;
  avatar_url: string | null;
  area: string | null;
  years_experience: number | null;
  is_accepting: number;
}

interface ProviderProfileRow extends ProviderSummaryRow {
  bio: string | null;
  phone: string;
}

// A search result: the provider plus their base rate for the searched trade.
// DECIMAL comes back as a string and stays one, like requests.price.
export interface ProviderInCategory extends ProviderSummary {
  baseRate: string | null;
}

interface ProviderInCategoryRow extends ProviderSummaryRow {
  base_rate: string | null;
}

// A trade the provider offers, with their "from" price for it (null = not set).
export interface OfferedCategory extends Category {
  baseRate: string | null;
}

export interface CategoryRate {
  categoryId: number;
  baseRate: string | null;
}

interface OfferedCategoryRow extends RowDataPacket {
  id: number;
  name: string;
  base_rate: string | null;
}

function mapSummaryRow(row: ProviderSummaryRow): ProviderSummary {
  return {
    id: row.id,
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    area: row.area,
    yearsExperience: row.years_experience,
    isAccepting: Boolean(row.is_accepting),
  };
}

// Providers who offer the category and are accepting jobs, optionally only in
// one area (exact match; providers.area is plain text). pc.category_id is
// served by fk_pc_category; the joins are on primary keys. The two variants
// are fixed strings, never built from input.
const ACCEPTING_IN_CATEGORY_SQL = `SELECT u.id, u.full_name, u.avatar_url, p.area,
          p.years_experience, p.is_accepting, pc.base_rate
   FROM provider_categories pc
   JOIN providers p ON p.id = pc.provider_id
   JOIN users u ON u.id = p.id
   WHERE pc.category_id = ? AND p.is_accepting = 1`;

export async function listProvidersByCategory(
  categoryId: number,
  area: string | null
): Promise<ProviderInCategory[]> {
  const [rows] =
    area === null
      ? await pool.query<ProviderInCategoryRow[]>(
          `${ACCEPTING_IN_CATEGORY_SQL} ORDER BY u.full_name, u.id`,
          [categoryId]
        )
      : await pool.query<ProviderInCategoryRow[]>(
          `${ACCEPTING_IN_CATEGORY_SQL} AND p.area = ? ORDER BY u.full_name, u.id`,
          [categoryId, area]
        );
  return rows.map((row) => ({
    ...mapSummaryRow(row),
    baseRate: row.base_rate,
  }));
}

export async function findProviderProfile(
  providerId: string
): Promise<ProviderProfile | null> {
  const [rows] = await pool.query<ProviderProfileRow[]>(
    `SELECT u.id, u.full_name, u.avatar_url, u.phone, p.bio, p.area,
            p.years_experience, p.is_accepting
     FROM providers p
     JOIN users u ON u.id = p.id
     WHERE p.id = ?`,
    [providerId]
  );
  const row = rows[0];
  return row ? { ...mapSummaryRow(row), bio: row.bio, phone: row.phone } : null;
}

export interface ProviderProfileChanges {
  isAccepting?: boolean;
  bio?: string | null;
  yearsExperience?: number | null;
  area?: string | null;
}

// A field that is absent stays unchanged; null clears it. COALESCE can't tell
// those apart, so the SET list is assembled from these fixed fragments — only
// the fragments come from code, every value is a parameter.
const PROFILE_CHANGE_FRAGMENTS: ReadonlyArray<
  [keyof ProviderProfileChanges, string]
> = [
  ["isAccepting", "is_accepting = ?"],
  ["bio", "bio = ?"],
  ["yearsExperience", "years_experience = ?"],
  ["area", "area = ?"],
];

export async function updateProviderProfile(
  providerId: string,
  changes: ProviderProfileChanges
): Promise<void> {
  const fragments: string[] = [];
  const values: Array<string | number | boolean | null> = [];
  for (const [field, fragment] of PROFILE_CHANGE_FRAGMENTS) {
    const value = changes[field];
    if (value !== undefined) {
      fragments.push(fragment);
      values.push(value);
    }
  }
  if (fragments.length === 0) return;
  await pool.query(
    `UPDATE providers SET ${fragments.join(", ")} WHERE id = ?`,
    [...values, providerId]
  );
}

// Takes an exclusive lock on the provider row for the rest of the transaction.
// Concurrent category replaces for the same provider then queue on this one
// parent row instead of taking child-row locks on provider_categories in
// different orders, which is what lets overlapping replaces deadlock.
export async function lockProviderForUpdate(
  conn: PoolConnection,
  providerId: string
): Promise<void> {
  await conn.query(`SELECT id FROM providers WHERE id = ? FOR UPDATE`, [
    providerId,
  ]);
}

// Replaces the provider's category set and rates in one transaction. Removed
// trades are deleted; the rest are upserted, so a trade that stays keeps its
// row and takes the new rate. The upsert also makes a concurrent replace that
// already inserted the same row harmless, without INSERT IGNORE's habit of
// hiding foreign-key errors. The row alias form replaces VALUES(), which
// MySQL 8.0.20+ deprecates in ON DUPLICATE KEY UPDATE.
export async function replaceProviderCategories(
  conn: PoolConnection,
  providerId: string,
  categories: readonly CategoryRate[]
): Promise<void> {
  await conn.query(
    `DELETE FROM provider_categories
     WHERE provider_id = ? AND category_id NOT IN (?)`,
    [providerId, categories.map((c) => c.categoryId)]
  );
  await conn.query(
    `INSERT INTO provider_categories (provider_id, category_id, base_rate)
     VALUES ? AS new
     ON DUPLICATE KEY UPDATE base_rate = new.base_rate`,
    [categories.map((c) => [providerId, c.categoryId, c.baseRate])]
  );
}

// Served by the provider_categories primary key (provider_id, category_id).
export async function listCategoriesForProvider(
  providerId: string
): Promise<OfferedCategory[]> {
  const [rows] = await pool.query<OfferedCategoryRow[]>(
    `SELECT c.id, c.name, pc.base_rate
     FROM provider_categories pc
     JOIN categories c ON c.id = pc.category_id
     WHERE pc.provider_id = ?
     ORDER BY c.name`,
    [providerId]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    baseRate: row.base_rate,
  }));
}

export async function insertProvider(
  conn: PoolConnection,
  input: { id: string; bio: string | null; yearsExperience: number | null }
): Promise<void> {
  await conn.query(
    `INSERT INTO providers (id, bio, years_experience) VALUES (?, ?, ?)`,
    [input.id, input.bio, input.yearsExperience]
  );
}

interface ProviderAcceptanceRow extends RowDataPacket {
  is_accepting: number;
}

// One query for both facts (exists, is_accepting) since they're the same
// row — a second round trip would just re-fetch what this already has.
export async function findProviderAcceptance(
  providerId: string
): Promise<{ isAccepting: boolean } | null> {
  const [rows] = await pool.query<ProviderAcceptanceRow[]>(
    `SELECT is_accepting FROM providers WHERE id = ? LIMIT 1`,
    [providerId]
  );
  const row = rows[0];
  return row ? { isAccepting: Boolean(row.is_accepting) } : null;
}

export async function providerAcceptsCategory(
  providerId: string,
  categoryId: number
): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 1 FROM provider_categories
     WHERE provider_id = ? AND category_id = ? LIMIT 1`,
    [providerId, categoryId]
  );
  return rows.length > 0;
}

// One weekly working window; times are "HH:MM".
export interface WeeklyHours {
  weekday: number;
  startTime: string;
  endTime: string;
}

interface AvailabilityRow extends RowDataPacket {
  provider_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

// Served by the primary key (provider_id, weekday, start_time).
export async function listAvailability(
  providerIds: readonly string[]
): Promise<Array<WeeklyHours & { providerId: string }>> {
  if (providerIds.length === 0) return [];
  const [rows] = await pool.query<AvailabilityRow[]>(
    `SELECT provider_id, weekday, start_time, end_time
     FROM provider_availability WHERE provider_id IN (?)
     ORDER BY provider_id, weekday, start_time`,
    [providerIds]
  );
  return rows.map((row) => ({
    providerId: row.provider_id,
    weekday: row.weekday,
    startTime: row.start_time.slice(0, 5),
    endTime: row.end_time.slice(0, 5),
  }));
}

export async function replaceAvailability(
  conn: PoolConnection,
  providerId: string,
  hours: readonly WeeklyHours[]
): Promise<void> {
  await conn.query(`DELETE FROM provider_availability WHERE provider_id = ?`, [
    providerId,
  ]);
  if (hours.length === 0) return;
  await conn.query(
    `INSERT INTO provider_availability (provider_id, weekday, start_time, end_time)
     VALUES ?`,
    [hours.map((h) => [providerId, h.weekday, h.startTime, h.endTime])]
  );
}
