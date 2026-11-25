import { APIGatewayProxyEventQueryStringParameters, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import jwt from "jsonwebtoken";
import { env } from "../env";
import {JwtPayload} from "../types";
import {DynamoConnectionRepository} from "../repositories/connections-repository";
import {checkTable} from "../infra/ddb";
import {sessionIsCurrent, sessionStartOf} from "../services/session-service";

// $connect is the one route whose event carries the query string
export type ConnectEvent = APIGatewayProxyWebsocketEventV2 & {
    queryStringParameters?: APIGatewayProxyEventQueryStringParameters;
};

export const handler = async (event: ConnectEvent) => {
    // Validate token on $connect
    try {
        const { requestContext, queryStringParameters } = event;
        const token = queryStringParameters?.token;
        const connectionId = requestContext.connectionId;

        if (!token) {
            return {
                statusCode: 401,
                body: "Missing token"
            };
        }

        const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
        const userId = String(payload._id);
        const authTime = sessionStartOf(payload);

        await checkTable(env.CONNECTIONS_TABLE);

        console.log("[Connect].handler(): user info", payload._id, payload.username);

        // The API's rules for a request: an account that is no longer active, or a token whose
        // session signed in before the account's last new password, is refused
        if (!(await sessionIsCurrent(userId, authTime))) {
            return {
                statusCode: 401,
                body: "Unauthorized user"
            };
        }

        // Map connection to user
        await DynamoConnectionRepository.put(userId, connectionId);

        console.log("[Connect].handler(): payload and connection id", userId, connectionId);

        return {
            statusCode: 200,
            body: "Connected"
        };
    } catch (err: any) {
        console.error("[Connect].handler(): error", err);
        return {
            statusCode: 401,
            body: "Unauthorized"
        };
    }
};
