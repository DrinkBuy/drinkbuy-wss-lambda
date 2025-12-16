import { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import jwt from "jsonwebtoken";
import { env } from "../env";
import {JwtPayload} from "../types";
import { connectMongo } from "../db/mongo";
import {DynamoConnectionRepository} from "../repositories/connections-repository";
import {UserModel} from "../models/user";
import {checkTable} from "src/infra/ddb";

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
    // Validate token on $connect
    try {
        // @ts-ignore
        const { requestContext, queryStringParameters } = event;
        const token = queryStringParameters?.token;
        const connectionId = requestContext.connectionId!;

        if (!token) {
            return {
                statusCode: 401,
                body: "Missing token"
            };
        }

        const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

        await checkTable(env.CONNECTIONS_TABLE);
        await connectMongo();

        const user = await UserModel.findById(payload._id).lean();

        console.log("[Connect].handler(): user info", payload._id, payload.username);

        if (!user) {
            return {
                statusCode: 401,
                body: "Unauthorized user"
            };
        }

        // Map connection to user
        await DynamoConnectionRepository.put(
            String(payload._id),
            connectionId
        );

        console.log("[Connect].handler(): payload and connection id", String(payload._id), connectionId);

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
