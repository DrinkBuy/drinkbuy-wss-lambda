import mongoose, { Schema } from 'mongoose';
import { TypeUserCommandScopeEnum } from '../types';

export interface IUserCommandModel extends mongoose.Document {
    user_id: mongoose.Types.ObjectId;
    username: string;
    scope: TypeUserCommandScopeEnum;
    command: string;
    executed: boolean;
    issued_at?: Date | null;
    expires_at?: Date | null;
    created_at?: Date;
    executed_at?: Date;
}

const userCommandSchema = new Schema<IUserCommandModel>(
    {
        user_id: { type: Schema.Types.ObjectId, required: true },
        username: { type: String, required: true },
        scope: { type: String, enum: Object.values(TypeUserCommandScopeEnum), required: true },
        command: { type: String, required: true },
        executed: { type: Boolean, required: true, default: false },
        issued_at: { type: Date, default: null },
        expires_at: { type: Date, default: null },
        created_at: { type: Date, default: Date.now, index: true },
        executed_at: { type: Date, default: null },
    },
    { timestamps: { createdAt: 'created_at' } }
);

export const UserCommandModel = mongoose.models.User_Command || mongoose.model<IUserCommandModel>('User_Command', userCommandSchema);
