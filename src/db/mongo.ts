import mongoose from "mongoose";
import {env} from "../env";

export const connectMongo = async (): Promise<void> => {
    try {
        console.log(`[Mongo].connectMongo(): Try MongoDB connecting ${env.MONGODB_URI}`);

        await mongoose.connect(env.MONGODB_URI, {
            user: env.MONGODB_USER,
            pass: env.MONGODB_PASS,
        });

        console.log("[Mongo].connectMongo(): MongoDB connected!");
    } catch (error) {
        console.error("[Mongo].connectMongo(): connection failed:", (error as Error).message);
        throw error;
    }
};
