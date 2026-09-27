import {
  findPublicUserById,
  findPasswordHashById,
  updateUserProfile,
  updatePasswordAndClearResetToken,
  type PublicUser,
  type UserProfileChanges,
} from "../models-db/users";
import { hashPassword, verifyPassword } from "./password";
import { UnauthorizedError, ForbiddenError } from "../constants/errors";

// A valid token whose account no longer exists no longer identifies anyone,
// so this is an authentication failure (401) and the client should log out.
const ACCOUNT_GONE_MESSAGE = "Account no longer exists";

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await findPublicUserById(userId);
  if (!user) {
    throw new UnauthorizedError(ACCOUNT_GONE_MESSAGE);
  }
  return user;
}

export async function updateCurrentUser(
  userId: string,
  changes: UserProfileChanges
): Promise<PublicUser> {
  await getCurrentUser(userId);
  await updateUserProfile(userId, changes);
  return getCurrentUser(userId);
}

// Known limitation: changing the password does not invalidate JWTs already
// issued — tokens are stateless and nothing tracks or revokes them. Doing so
// needs a token-version column checked on every request; not built for MVP.
// The outstanding password-reset token, which is stored, is cleared.
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const storedHash = await findPasswordHashById(userId);
  if (storedHash === null) {
    throw new UnauthorizedError(ACCOUNT_GONE_MESSAGE);
  }
  // 403, not 401: a client treats 401 as an expired session and logs out.
  if (!(await verifyPassword(currentPassword, storedHash))) {
    throw new ForbiddenError("Current password is incorrect");
  }
  await updatePasswordAndClearResetToken(
    userId,
    await hashPassword(newPassword)
  );
}
