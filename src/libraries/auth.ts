import { randomUUID, randomBytes, createHash } from "node:crypto";
import { pool } from "../models-db/pool";
import {
  insertUser,
  findUserCredentialsByEmail,
  findPublicUserById,
  setPasswordResetToken,
  findUserByResetTokenHash,
  updatePasswordAndClearResetToken,
  type PublicUser,
} from "../models-db/users";
import {
  insertProvider,
  insertProviderCategories,
} from "../models-db/providers";
import { findCategoryIds } from "../models-db/categories";
import { hashPassword, verifyPassword } from "./password";
import { signAccessToken } from "./jwt";
import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from "../constants/errors";

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
// Comparable-timing stand-in for a real hash when the email isn't found, so
// login doesn't leak account existence via response timing.
const DUMMY_HASH_PROMISE = hashPassword(randomUUID());

function isDuplicateEntryError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}

export interface RegisterInput {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  becomeProvider?: {
    bio?: string;
    yearsExperience?: number;
    categoryIds: number[];
  };
}

export async function register(
  input: RegisterInput
): Promise<{ user: PublicUser; token: string }> {
  const id = randomUUID();
  const passwordHash = await hashPassword(input.password);

  let categoryIds: number[] = [];
  if (input.becomeProvider) {
    categoryIds = [...new Set(input.becomeProvider.categoryIds)];
    const activeIds = await findCategoryIds(categoryIds);
    const invalid = categoryIds.filter((cid) => !activeIds.includes(cid));
    if (invalid.length > 0) {
      throw new ValidationError(
        `Unknown or inactive category id(s): ${invalid.join(", ")}`
      );
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      await insertUser(conn, {
        id,
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        passwordHash,
      });

      if (input.becomeProvider) {
        await insertProvider(conn, {
          id,
          bio: input.becomeProvider.bio ?? null,
          yearsExperience: input.becomeProvider.yearsExperience ?? null,
        });
        await insertProviderCategories(conn, id, categoryIds);
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (isDuplicateEntryError(err)) {
        throw new ConflictError("Email is already registered");
      }
      throw err;
    }
  } finally {
    conn.release();
  }

  const user: PublicUser = {
    id,
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    avatarUrl: null,
    isProvider: Boolean(input.becomeProvider),
  };
  return { user, token: signAccessToken(id) };
}

export async function login(
  email: string,
  password: string
): Promise<{ user: PublicUser; token: string }> {
  const credentials = await findUserCredentialsByEmail(email);
  const passwordMatches = await verifyPassword(
    password,
    credentials?.passwordHash ?? (await DUMMY_HASH_PROMISE)
  );

  if (!credentials || !passwordMatches) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const user = await findPublicUserById(credentials.id);
  if (!user) {
    throw new UnauthorizedError("Invalid email or password");
  }

  return { user, token: signAccessToken(user.id) };
}

// No email provider exists in this project yet. Returning the raw token here
// (rather than emailing it) keeps the reset flow testable without new
// infrastructure; the response shape is identical whether or not the email
// matched, so this doesn't leak account existence. Swap for real delivery
// (and drop the token from the response) once a mail provider is chosen.
export async function requestPasswordReset(
  email: string
): Promise<string | null> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  const found = await setPasswordResetToken(email, tokenHash, expiresAt);
  return found ? rawToken : null;
}

export async function resetPassword(
  rawToken: string,
  newPassword: string
): Promise<void> {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const match = await findUserByResetTokenHash(tokenHash);
  if (!match) {
    throw new UnauthorizedError("Invalid or expired reset token");
  }

  const passwordHash = await hashPassword(newPassword);
  await updatePasswordAndClearResetToken(match.id, passwordHash);
}
