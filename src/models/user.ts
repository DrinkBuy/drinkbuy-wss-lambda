import mongoose, { Schema } from 'mongoose';

export interface IUser {
    _id?: mongoose.Types.ObjectId;
    bar_id?: mongoose.Types.ObjectId;
    username: string;
    role: string;
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
}, { strict: false }); // keep flexible to match existing schema

export const UserModel = mongoose.models.User || mongoose.model<IUser>('User', userSchema);
