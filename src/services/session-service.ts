import { connectMongo } from "../db/mongo";
import { UserModel } from "../models/user";
import { TypeUserStatusEnum } from "../types";

// The API owns these rules (drink-buy-api src/core/util/session-start.ts and
// src/core/domain/session-cutoff.ts). They are repeated here so that a socket ends with the
// same session as a request does; keep the two in step.

/** The password cut-off an account carries: every session that signed in before it is over. */
type SessionCutoff = { sessions_valid_after?: Date | null };

/**
 * When the session a token belongs to signed in, in epoch seconds: its auth_time, or its iat for
 * a token signed before auth_time existed. Null when the token says neither.
 */
export function sessionStartOf(claims: object): number | null {
    if ("auth_time" in claims) {
        return typeof claims.auth_time === "number" ? claims.auth_time : null;
    }
    return "iat" in claims && typeof claims.iat === "number" ? claims.iat : null;
}

/**
 * Whether the account's password changed after the session that signed in at authTime. The
 * cut-off keeps milliseconds and auth_time can carry a fraction of a second, so within the
 * change's own second a sign-in just before it is over and one just after it is not. A session
 * with no known sign-in time cannot show that it came after a change.
 */
export function passwordChangedSince(account: SessionCutoff, authTime: number | null): boolean {
    const cutoff = account.sessions_valid_after;
    if (!cutoff) return false;
    // Rounded: a time in seconds with a fraction does not always come back to its exact millisecond
    return authTime === null || Math.round(authTime * 1000) < cutoff.getTime();
}

/** Whether the account is still active and its password has not changed since authTime. */
export async function sessionIsCurrent(userId: string, authTime: number | null): Promise<boolean> {
    await connectMongo();
    const user = await UserModel.findById(userId).select("status sessions_valid_after").lean();
    return user?.status === TypeUserStatusEnum.ACTIVE && !passwordChangedSince(user, authTime);
}
