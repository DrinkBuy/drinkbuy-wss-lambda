import { APIGatewayProxyEventV2 } from "aws-lambda";
import { connectMongo } from "../db/mongo";
import {publishCommandAndFanOut} from "../services/publisher-service";
import {UserCommandModel} from "../models/user-command";
import {checkTable, scanTable} from "../infra/ddb";
import {env} from "../env";

export const handler = async (event: APIGatewayProxyEventV2) => {
    try {
        const body = event.body ? JSON.parse(event.body) : {};

        // For test and dev env
        await checkTable(env.CONNECTIONS_TABLE);
        await scanTable(env.CONNECTIONS_TABLE);

        await connectMongo();

        // Persist the command (mirrors your UserService.createCommandExecute, but without roles/deps)
        const created = await new UserCommandModel({
            user_id: body.user_id,
            username: body.username,
            scope: body.scope,
            command: body.command,
            executed: false,
        }).save();

        console.log("[HttpPublish].handler() user command created");

        // Fan-out to all active connections for this user
        await publishCommandAndFanOut({
            _id: String(created._id),
            user_id: String(created.user_id),
            username: created.username,
            scope: created.scope,
            command: created.command,
            executed: created.executed,
            created_at: created.created_at,
        });

        return {
            statusCode: 201,
            body: JSON.stringify({
                ok: true,
                id: String(created._id)
            })
        };
    } catch (err: any) {
        console.error("[HttpPublish].handler() error", err);
        return {
            statusCode: 500,
            body: JSON.stringify({
                ok: false,
                error: err?.message || "error"
            })
        };
    }
};
