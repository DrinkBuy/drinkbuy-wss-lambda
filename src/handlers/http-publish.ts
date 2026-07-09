import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { connectMongo } from "../db/mongo";
import { publishCommandAndFanOut } from "../services/publisher-service";
import { IUserCommandModel, UserCommandModel } from "../models/user-command";
import { UserModel } from "../models/user";
import { TypeUserCommandScopeEnum } from "../types";

const JSON_HEADERS = { "Content-Type": "application/json" };

type PublishBody = {
    user_id?: string;
    username?: string;
    scope?: TypeUserCommandScopeEnum;
    command?: string;
};

const json = (statusCode: number, payload: unknown): APIGatewayProxyResultV2 => ({
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
});

function parseBody(raw: string | undefined): PublishBody {
    if (!raw) return {};
    try {
        return JSON.parse(raw) as PublishBody;
    } catch {
        throw new Error("invalid JSON body");
    }
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
        let body: PublishBody;
        try {
            body = parseBody(event.body);
        } catch (err) {
            return json(400, { ok: false, error: (err as Error).message });
        }

        if (!body.scope || !body.command || !body.user_id) {
            return json(400, { ok: false, error: "user_id, scope and command are required" });
        }

        await connectMongo();

        if (body.user_id === "ALL") {
            const users = await UserModel.find().select("_id username").lean().exec();
            await Promise.all(
                users.map((user) =>
                    createAndPublish({
                        user_id: String(user._id),
                        username: user.username,
                        scope: body.scope!,
                        command: body.command!,
                    })
                )
            );

            console.log(`[HttpPublish].handler() user command created for ${users.length} users`);

            return json(201, { ok: true, id: "ALL", count: users.length });
        }

        if (!body.username) {
            return json(400, { ok: false, error: "username is required" });
        }

        const created = await createAndPublish({
            user_id: body.user_id,
            username: body.username,
            scope: body.scope,
            command: body.command,
        });

        console.log("[HttpPublish].handler() user command created");

        return json(201, { ok: true, id: String(created._id) });
    } catch (err) {
        console.error("[HttpPublish].handler() error", err);

        const message = err instanceof Error ? err.message : "error";
        return json(500, { ok: false, error: message });
    }
};
