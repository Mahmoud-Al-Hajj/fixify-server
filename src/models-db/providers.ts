import type { PoolConnection } from "mysql2/promise";

export async function insertProvider(
  conn: PoolConnection,
  input: { id: string; bio: string | null; yearsExperience: number | null }
): Promise<void> {
  await conn.query(
    `INSERT INTO providers (id, bio, years_experience) VALUES (?, ?, ?)`,
    [input.id, input.bio, input.yearsExperience]
  );
}

export async function insertProviderCategories(
  conn: PoolConnection,
  providerId: string,
  categoryIds: readonly number[]
): Promise<void> {
  if (categoryIds.length === 0) return;
  const values = categoryIds.map((categoryId) => [providerId, categoryId]);
  await conn.query(
    `INSERT INTO provider_categories (provider_id, category_id) VALUES ?`,
    [values]
  );
}
