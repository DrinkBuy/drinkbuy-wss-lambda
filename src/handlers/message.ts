import { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { connectMongo } from "../db/mongo";
import {UserCommandModel} from "../models/user-command";
import {makeManagementClient, postToConnection} from "../utils/api-gw";
import {DynamoConnectionRepository} from "../repositories/connections-repository";

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

    if (msg?.action === "ping") {
        const userId = msg.userId;

        console.log("[Message].handler(): received ping from connection", connectionId, "userId", userId);

        if (userId) {
            await DynamoConnectionRepository.renew(String(userId), connectionId);
        }

        const client = makeManagementClient(
            requestContext.domainName,
            requestContext.stage
        );
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
