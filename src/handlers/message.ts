import { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { isObjectIdOrHexString } from "mongoose";
import { connectMongo } from "../db/mongo";
import {UserCommandModel} from "../models/user-command";
import {closeConnection, makeManagementClient, postToConnection} from "../utils/api-gw";
import {ConnectionOwner, DynamoConnectionRepository} from "../repositories/connections-repository";
import {sessionIsCurrent} from "../services/session-service";

// Bounds the $in one ack sends to Mongo; a panel acks what one delivery brought, far fewer
const MAX_ACKED_COMMANDS = 100;

const UNAUTHORIZED = { statusCode: 401, body: "Unauthorized" };

type ClientMessage = { action?: unknown; type?: unknown; commandIds?: unknown };

function parseMessage(body: string | undefined): ClientMessage {
    try {
        const parsed: unknown = body ? JSON.parse(body) : null;
        return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
        return {};
    }
}

// The token has not expired, the account is still active and its password has not changed since
// the session signed in. DynamoDB removes expired items lazily, so the owner's own expiry is
// checked here rather than trusted to have removed it.
async function ownerSessionIsLive(owner: ConnectionOwner): Promise<boolean> {
    if (owner.expiresAt <= Math.floor(Date.now() / 1000)) {
        return false;
    }
    return sessionIsCurrent(owner.userId, owner.authTime);
}

/**
 * The connection's owner while its session is live. Otherwise the connection ends: no owner (the
 * connection predates owners, or is unknown), a token that expired or a session that ended. Its
 * items go first, so pushes stop even if the close fails, and an honest client reconnects through
 * $connect, which checks its session again.
 */
async function liveOwnerOf(client: ApiGatewayManagementApiClient, connectionId: string) {
    // The user comes from the owner $connect recorded, never from the message: a user id there
    // is ignored, or any client could act as another user
    const owner = await DynamoConnectionRepository.findOwner(connectionId);
    if (owner && (await ownerSessionIsLive(owner))) {
        return owner;
    }
    if (owner) {
        await DynamoConnectionRepository.delete(owner.userId, connectionId);
    }
    await closeConnection(client, connectionId);
    return null;
}

async function handlePing(client: ApiGatewayManagementApiClient, connectionId: string) {
    const owner = await liveOwnerOf(client, connectionId);

    console.log("[Message].handlePing(): ping from connection", connectionId, "owner", owner?.userId);

    if (!owner) {
        return UNAUTHORIZED;
    }

    await DynamoConnectionRepository.renew(owner, connectionId);
    await postToConnection(client, connectionId, {
        type: "pong",
        ts: new Date().toISOString(),
    });

    return {
        statusCode: 200,
        body: "pong",
    };
}

/** The ids in an ack that can name a command, as many as one ack may mark. */
function ackableIds(commandIds: unknown): string[] {
    if (!Array.isArray(commandIds)) {
        return [];
    }
    return commandIds
        .filter((id): id is string => typeof id === "string" && isObjectIdOrHexString(id))
        .slice(0, MAX_ACKED_COMMANDS);
}

async function handleAck(client: ApiGatewayManagementApiClient, connectionId: string, commandIds: unknown) {
    try {
        const owner = await liveOwnerOf(client, connectionId);
        if (!owner) {
            return UNAUTHORIZED;
        }

        const ids = ackableIds(commandIds);
        if (ids.length) {
            await connectMongo();
            // Only the owner's own commands: an id taken from another user's list marks nothing
            await UserCommandModel.updateMany(
                { _id: { $in: ids }, user_id: owner.userId },
                { $set: { executed: true, executed_at: new Date() } }
            );
        }
        await postToConnection(client, connectionId, { type: "ok", payload: { acked: ids.length } });
        return {
            statusCode: 200,
            body: "ACK processed"
        };
    } catch (err) {
        console.error("[Message].handleAck(): ACK error", err);
        await postToConnection(client, connectionId, { type: "error", payload: { message: "ack_failed" } });
        return {
            statusCode: 200,
            body: "ACK error"
        };
    }
}

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
    const { requestContext, body } = event;
    const { connectionId } = requestContext;
    const msg = parseMessage(body);

    console.log("[Message].handler(): request context", requestContext.domainName, requestContext.stage);

    const client = makeManagementClient(requestContext.domainName, requestContext.stage);

    // Both panels' heartbeat sends {type: "ping"}, which API Gateway routes to $default; without
    // a pong they drop the socket and reconnect
    if (msg.action === "ping" || msg.type === "ping") {
        return handlePing(client, connectionId);
    }

    if (msg.action === "user-commands-ack") {
        return handleAck(client, connectionId, msg.commandIds);
    }

    await postToConnection(client, connectionId, {
        type: "error",
        payload: {
            message: "unknown_action"
        }
    });

    return {
        statusCode: 200,
        body: "Unknown action"
    };
};
