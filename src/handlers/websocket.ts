import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import * as Connect from "./connect";
import * as Disconnect from "./disconnect";
import * as Message from "./message";

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
    const route = event.requestContext.routeKey;
    if (route === "$connect") {
        return Connect.handler(event);
    }
    if (route === "$disconnect") {
        return Disconnect.handler(event);
    }
    return Message.handler(event);
};
