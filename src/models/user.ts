import mongoose, { Schema } from 'mongoose';

export interface IUser {
    _id?: mongoose.Types.ObjectId;
    bar_id?: mongoose.Types.ObjectId;
    username: string;
    role: string;
    status?: string;
    sessions_valid_after?: Date | null;
}

const userSchema = new Schema<IUser>({
    bar_id: { type: mongoose.Schema.Types.ObjectId, ref: "Bar", required: false, default: null },
    username: {
        type: String,
        required: true,
        unique: true
    },
    role: {
        type: String,
        required: true
    },
    status: { type: String },
    // Set by the API on each new password: every session that signed in before it is over
    sessions_valid_after: { type: Date },
}, { strict: false }); // keep flexible to match existing schema

export const UserModel: mongoose.Model<IUser> =
    mongoose.models.User || mongoose.model<IUser>('User', userSchema);
