import { randomUUID, randomBytes, createHash } from "node:crypto";
import { withTransaction, isDbError } from "../models-db/pool";
import {
  insertUser,
  findUserCredentialsByEmail,
  findPublicUserById,
  setPasswordResetToken,
  resetPasswordWithToken,
  type PublicUser,
} from "../models-db/users";
import {
  insertProvider,
  replaceProviderCategories,
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

  try {
    await withTransaction(async (conn) => {
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
        // Sign-up sets trades only; rates are set later (PUT /providers/me/categories).
        await replaceProviderCategories(
          conn,
          id,
          categoryIds.map((categoryId) => ({ categoryId, baseRate: null }))
        );
      }
    });
  } catch (err) {
    if (isDbError(err, "ER_DUP_ENTRY", "uq_users_email")) {
      throw new ConflictError("Email is already registered");
    }
    throw err;
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

// Stores a new reset token hash for the email, if it is registered. The raw
// token is never returned or logged: it must only reach the account owner,
// and no delivery channel (email) exists yet.
export async function requestPasswordReset(email: string): Promise<void> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await setPasswordResetToken(email, tokenHash, expiresAt);
}

export async function resetPassword(
  rawToken: string,
  newPassword: string
): Promise<void> {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const passwordHash = await hashPassword(newPassword);
  if (!(await resetPasswordWithToken(tokenHash, passwordHash))) {
    throw new UnauthorizedError("Invalid or expired reset token");
  }
}
