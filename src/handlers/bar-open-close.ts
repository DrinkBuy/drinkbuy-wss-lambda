// src/handlers/bar-open-close-scheduled.ts
import { connectMongo } from "../db/mongo";
import { runBarOpenCloseTick } from "../services/bar-service";

export const handler = async (event: any) => {
    console.log("[BarOpenClose].handler() event", JSON.stringify(event));

    if (event?.action !== "scheduled_open_closed_bars") {
        return {
            ok: true,
            ignored: true
        };
    }

    await connectMongo();

    const result = await runBarOpenCloseTick();

    return {
        statusCode: 200,
        body: JSON.stringify(result),
    };
};
