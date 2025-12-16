import { env } from "../env";
import { UserCommandOut, PostToConnectionStatus } from "../types";
import { makeManagementClient, postToConnection } from "../utils/api-gw";
import { DynamoConnectionRepository } from "../repositories/connections-repository";

export async function publishToUser(userId: string, event: any) {
    console.log(`[PublishService].publishToUser(): env.WEBSOCKET_DOMAIN ${env.WEBSOCKET_DOMAIN}`);
    console.log(`[PublishService].publishToUser(): env.WEBSOCKET_STAGE ${env.WEBSOCKET_STAGE}`);
    console.log(`[PublishService].publishToUser(): env.API_GW_WS_ENDPOINT ${env.API_GW_WS_ENDPOINT || "empty"}`);

    const client = makeManagementClient(
        env.WEBSOCKET_DOMAIN,
        env.WEBSOCKET_STAGE,
        env.WEBSOCKET_API_ENDPOINT?.replace("wss://", "https://")
    );

    const connections = await DynamoConnectionRepository.listByUser(userId);

    console.log(`[PublishService].publishToUser(): found ${connections.length} connections for user ${userId}`);

    for (const connectionId of connections) {
        const status = await postToConnection(client, connectionId, event);
        if (status === PostToConnectionStatus.GONE) {
            await DynamoConnectionRepository.delete(userId, connectionId);
        }
    }
}

export async function publishCommandAndFanOut(command: UserCommandOut) {
    const event = {
        type: "user-command",
        ...command,
    };
    try {
        console.log("[PublishService].publishCommandAndFanOut(): user_id", String(command.user_id));
        console.log("[PublishService].publishCommandAndFanOut(): event", event);
        await publishToUser(String(command.user_id), event);
    } catch (error) {
        console.error("[PublishService].publishCommandAndFanOut(): error", error);
    }
}
