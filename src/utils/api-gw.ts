import {
    ApiGatewayManagementApiClient,
    PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { PostToConnectionStatus } from "../types";

export function makeManagementClient(
    domainName?: string,
    stage?: string,
    overrideEndpoint?: string
) {
    const endpoint = overrideEndpoint || (domainName && stage ? `https://${domainName}/${stage}` : undefined);

    console.log(`[ApiGW].makeManagementClient(): endpoint ${endpoint}`);

    if (!endpoint) {
        throw new Error(
            "[ApiGW].makeManagementClient(): ApiGatewayManagementApi endpoint missing"
        );
    }

    return new ApiGatewayManagementApiClient({
        endpoint,
    });
}

export async function postToConnection(
    client: ApiGatewayManagementApiClient,
    connectionId: string,
    data: any): Promise<PostToConnectionStatus> {

    const payload = typeof data === "string" ? data : JSON.stringify(data ?? {});

    try {
        await client.send(
            new PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: Buffer.from(payload),
            })
        );
        return PostToConnectionStatus.OK;
    } catch (err: any) {
        console.error("[ApiGW].postToConnection(): error", err);

        const statusCode =
            err?.$metadata?.httpStatusCode ??
            err?.statusCode ??
            err?.$response?.statusCode;

        if (statusCode === 410 || err?.name === "GoneException") {
            console.warn(
                `[ApiGW].postToConnection(): connection ${connectionId} is gone (410).`
            );
            return PostToConnectionStatus.GONE;
        }

        return PostToConnectionStatus.ERROR;
    }
}
