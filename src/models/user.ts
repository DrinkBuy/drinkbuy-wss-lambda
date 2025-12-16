import mongoose, { Schema } from 'mongoose';

export interface IUserModel extends mongoose.Document {
    username: string;
    role: string;
}

const userSchema = new Schema<IUserModel>({
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

export const UserModel = mongoose.models.User || mongoose.model<IUserModel>('User', userSchema);
