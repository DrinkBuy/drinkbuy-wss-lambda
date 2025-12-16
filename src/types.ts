export type JwtPayload = { _id: string; username: string };

export enum TypeUserCommandScopeEnum {
    TENANT = "tenant",
    USER = "user",
    GLOBAL = "global",
}

export enum TypeUserCommandEnum {
    // add your command types here
}

export enum PostToConnectionStatus {
    OK = "ok",
    GONE = "gone",
    ERROR = "error",
}

export type WsEvent =
    | { type: 'user-command'; payload: UserCommandOut }
    | { type: 'user-commands-pending'; payload: UserCommandOut[] }
    | { type: 'error'; payload: { message: string; detail?: string } };

export type ClientMessage =
    | { action: 'user-commands-ack'; commandIds: string[] }
    | { action: string; [k: string]: any };

export type UserCommandDoc = {
    _id?: string;
    user_id: string;
    username: string;
    scope: TypeUserCommandScopeEnum;
    command: string; // TypeUserCommandEnum | string
    executed: boolean;
    issued_at?: Date | null;
    expires_at?: Date | null;
    created_at?: Date;
    executed_at?: Date;
};

export type UserDoc = {
    _id: string;
    username: string;
    role: string;
};

export type UserCommandOut = {
    _id: string;
    user_id: string;
    username: string;
    scope: string;
    command: string;
    executed: boolean;
    created_at?: Date;
};
