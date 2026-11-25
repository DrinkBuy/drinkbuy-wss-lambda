import { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { connectMongo } from "../db/mongo";
import {UserCommandModel} from "../models/user-command";
import {closeConnection, makeManagementClient, postToConnection} from "../utils/api-gw";
import {ConnectionOwner, DynamoConnectionRepository} from "../repositories/connections-repository";
import {sessionIsCurrent} from "../services/session-service";

// The token has not expired, the account is still active and its password has not changed since
// the session signed in. DynamoDB removes expired items lazily, so the owner's own expiry is
// checked here rather than trusted to have removed it.
async function ownerSessionIsLive(owner: ConnectionOwner): Promise<boolean> {
    if (owner.expiresAt <= Math.floor(Date.now() / 1000)) {
        return false;
    }
    return sessionIsCurrent(owner.userId, owner.authTime);
}

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
    const { requestContext, body } = event;
    const connectionId = requestContext.connectionId!;

    let msg: any;
    try {
        msg = body ? JSON.parse(body) : {};
    } catch {
        msg = {};
    }

    console.log("[Message].handler(): request context", requestContext.domainName, requestContext.stage);

    // Both panels' heartbeat sends {type: "ping"}, which API Gateway routes to $default; without
    // a pong they drop the socket and reconnect
    if (msg?.action === "ping" || msg?.type === "ping") {
        const client = makeManagementClient(
            requestContext.domainName,
            requestContext.stage
        );

        // The user comes from the owner $connect recorded, never from the message: a user id
        // there is ignored, or any client could subscribe to another user's pushes
        const owner = await DynamoConnectionRepository.findOwner(connectionId);

        console.log("[Message].handler(): received ping from connection", connectionId, "owner", owner?.userId);

        if (!owner || !(await ownerSessionIsLive(owner))) {
            // No owner (the connection predates owners, or is unknown), a token that expired or
            // a session that ended. Closing makes an honest client reconnect, and $connect checks
            // its session again.
            if (owner) {
                await DynamoConnectionRepository.delete(owner.userId, connectionId);
            }
            await closeConnection(client, connectionId);
            return {
                statusCode: 401,
                body: "Unauthorized",
            };
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

    if (msg?.action === "user-commands-ack") {
        try {
            await connectMongo();
            const ids = Array.isArray(msg.commandIds) ? msg.commandIds : [];
            if (ids.length) {
                await UserCommandModel.updateMany(
                    { _id: { $in: ids } },
                    { $set: { executed: true, executed_at: new Date() } }
                );
            }
            const client = makeManagementClient(requestContext.domainName, requestContext.stage);
            await postToConnection(client, connectionId, { type: "ok", payload: { acked: ids.length } });
            return {
                statusCode: 200,
                body: "ACK processed"
            };
        } catch (err) {
            console.error("[Message].handler(): ACK error", err);
            const client = makeManagementClient(requestContext.domainName, requestContext.stage);
            await postToConnection(client, connectionId, { type: "error", payload: { message: "ack_failed" } });
            return {
                statusCode: 200,
                body: "ACK error"
            };
        }
    }

    // Unknown action
    const client = makeManagementClient(requestContext.domainName, requestContext.stage);

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
