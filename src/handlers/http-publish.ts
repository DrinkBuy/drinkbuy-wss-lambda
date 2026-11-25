import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import jwt from "jsonwebtoken";
import { isObjectIdOrHexString } from "mongoose";
import { env } from "../env";
import { connectMongo } from "../db/mongo";
import { publishCommandAndFanOut } from "../services/publisher-service";
import { sessionIsCurrent, sessionStartOf } from "../services/session-service";
import { IUserCommandModel, UserCommandModel } from "../models/user-command";
import { UserModel } from "../models/user";
import { TypeUserCommandEnum, TypeUserCommandScopeEnum } from "../types";

const JSON_HEADERS = { "Content-Type": "application/json" };

const ALL_USERS = "ALL";
const DRINKBUY_ADMIN = "drinkbuy_admin";

type PublishRequest = {
    /** A user's id, or ALL_USERS. */
    user_id: string;
    scope: TypeUserCommandScopeEnum;
    command: TypeUserCommandEnum;
};

/** Whom a token speaks for, once its signature checks out. */
type Signer = { userId: string; authTime: number | null };

const json = (statusCode: number, payload: unknown): APIGatewayProxyResultV2 => ({
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
});

const unauthorized = () => json(401, { ok: false, error: "unauthorized" });
const forbidden = () => json(403, { ok: false, error: "forbidden" });

function bearerToken(authorization: string | undefined): string | null {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    return match ? match[1] : null;
}

function verifiedSigner(token: string, options: { ignoreExpiration: boolean }): Signer | null {
    try {
        const claims = jwt.verify(token, env.JWT_SECRET, options);
        if (typeof claims === "string" || typeof claims._id !== "string") {
            return null;
        }
        return { userId: claims._id, authTime: sessionStartOf(claims) };
    } catch {
        return null;
    }
}

function isOneOf<T extends string>(values: Record<string, T>, value: unknown): value is T {
    return Object.values(values).some((known) => known === value);
}

/** The request, or null when the body is not JSON naming a user (or ALL), a known scope and a known command. */
function parseRequest(raw: string | undefined): PublishRequest | null {
    let body: unknown;
    try {
        body = JSON.parse(raw ?? "");
    } catch {
        return null;
    }
    if (typeof body !== "object" || body === null) {
        return null;
    }
    const userId = "user_id" in body ? body.user_id : undefined;
    const scope = "scope" in body ? body.scope : undefined;
    const command = "command" in body ? body.command : undefined;
    if (typeof userId !== "string" || (userId !== ALL_USERS && !isObjectIdOrHexString(userId))) {
        return null;
    }
    if (!isOneOf(TypeUserCommandScopeEnum, scope) || !isOneOf(TypeUserCommandEnum, command)) {
        return null;
    }
    return { user_id: userId, scope, command };
}

/**
 * The API refreshes a bar user's active orders by sending that user's own stored token, which may
 * have expired by then. Any signed token is therefore good for this one command, and for nothing
 * else: the most its holder can do is refresh the same user's order list.
 */
function isOwnOrderRefresh(signer: Signer, request: PublishRequest): boolean {
    return (
        request.user_id === signer.userId &&
        request.command === TypeUserCommandEnum.ACTIVE_ORDER_REFRESH &&
        request.scope === TypeUserCommandScopeEnum.USER
    );
}

/** The refusal for a signer who may not publish this request, or null when they may. */
async function refusal(token: string, signer: Signer, request: PublishRequest): Promise<APIGatewayProxyResultV2 | null> {
    if (isOwnOrderRefresh(signer, request)) {
        return null;
    }
    // Anything else needs a live admin session, which the admin screens of both panels send.
    // The signature was checked with expiry ignored; here an expired token is refused.
    const unexpired = verifiedSigner(token, { ignoreExpiration: false }) !== null;
    if (!unexpired || !(await sessionIsCurrent(signer.userId, signer.authTime))) {
        return unauthorized();
    }
    const account = await UserModel.findById(signer.userId).select("role").lean();
    return account?.role === DRINKBUY_ADMIN ? null : forbidden();
}

async function createAndPublish(input: {
    user_id: string;
    username: string;
    scope: TypeUserCommandScopeEnum;
    command: string;
}): Promise<IUserCommandModel> {
    const created = await new UserCommandModel({ ...input, executed: false }).save();

    await publishCommandAndFanOut({
        _id: String(created._id),
        user_id: String(created.user_id),
        username: created.username,
        scope: created.scope,
        command: created.command,
        executed: created.executed,
        created_at: created.created_at,
    });

    return created;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    try {
        // Authentication comes before the body is read; the token itself is never logged
        const token = bearerToken(event.headers.authorization);
        const signer = token ? verifiedSigner(token, { ignoreExpiration: true }) : null;
        if (!token || !signer) {
            return unauthorized();
        }

        const request = parseRequest(event.body);
        if (!request) {
            return json(400, { ok: false, error: "user_id, a known scope and a known command are required" });
        }

        await connectMongo();

        const refused = await refusal(token, signer, request);
        if (refused) {
            console.warn("[HttpPublish].handler() refused a command from user", signer.userId);
            return refused;
        }

        const { scope, command } = request;

        if (request.user_id === ALL_USERS) {
            const users = await UserModel.find().select("_id username").lean().exec();
            await Promise.all(
                users.map((user) =>
                    createAndPublish({ user_id: String(user._id), username: user.username, scope, command })
                )
            );

            console.log(`[HttpPublish].handler() user command created for ${users.length} users`);

            return json(201, { ok: true, id: ALL_USERS, count: users.length });
        }

        // The username comes from the account, so a command cannot be filed under another name
        const target = await UserModel.findById(request.user_id).select("username").lean();
        if (!target) {
            return json(404, { ok: false, error: "user not found" });
        }

        const created = await createAndPublish({ user_id: request.user_id, username: target.username, scope, command });

        console.log("[HttpPublish].handler() user command created");

        return json(201, { ok: true, id: String(created._id) });
    } catch (err) {
        console.error("[HttpPublish].handler() error", err);

        const message = err instanceof Error ? err.message : "error";
        return json(500, { ok: false, error: message });
    }
};
