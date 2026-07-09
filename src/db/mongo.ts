import mongoose from "mongoose";
import {env} from "../env";

// Reused across warm invocations of the same execution environment.
let connecting: Promise<unknown> | null = null;

// Drop the memoized promise so the next invocation dials again instead of
// awaiting an already-resolved promise over a dead socket
mongoose.connection.on("disconnected", () => {
    connecting = null;
});

export const connectMongo = async (): Promise<void> => {
    if (mongoose.connection.readyState === 1) {
        return;
    }

    if (!connecting) {
        console.log(`[Mongo].connectMongo(): Try MongoDB connecting ${env.MONGODB_URI}`);

        connecting = mongoose
            .connect(env.MONGODB_URI, {
                user: env.MONGODB_USER,
                pass: env.MONGODB_PASS,
                // Must stay well under the Lambda timeout, otherwise the function is
                // killed mid-handshake, and API Gateway answers "Internal Server Error"
                // instead of the handler's JSON error body
                serverSelectionTimeoutMS: 5000,
            })
            .then((conn) => {
                console.log("[Mongo].connectMongo(): MongoDB connected!");
                return conn;
            })
            .catch((error) => {
                connecting = null;
                console.error("[Mongo].connectMongo(): connection failed:", (error as Error).message);
                throw error;
            });
    }

    await connecting;
};
