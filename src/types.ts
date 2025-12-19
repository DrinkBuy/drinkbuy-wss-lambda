// noinspection SpellCheckingInspection

export type JwtPayload = { _id: string; username: string };

export enum TypeUserStatusEnum {
    ACTIVE = "active",
    INACTIVE = "inactive",
    BANNED = "banned",
}

export enum TypeUserCommandScopeEnum {
    TENANT = "tenant",
    USER = "user",
    GLOBAL = "global",
}

export enum TypeUserCommandEnum {
    ALL = "ALL",
    RELOAD = "RELOAD",
    LOGOUT = "LOGOUT",
    AUDIO_RED_SCREEN_RESET_COMMAND = "AUDIO_RED_SCREEN_RESET_COMMAND",
    ACTIVE_ORDER_RESET_COMMAND = "ACTIVE_ORDER_RESET_COMMAND",
    TOKEN_STORAGE_RESET_COMMAND = "TOKEN_STORAGE_RESET_COMMAND",
    ACTIVE_ORDER_REFRESH = "ACTIVE_ORDER_REFRESH",
    BAR_OPEN_CLOSED = "BAR_OPEN_CLOSED",
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

export enum TypeServiceModeEnum {
    PICKUP = "pickup",
    TABLE_SERVICE_ON = "tableservice_on",
    TABLE_SERVICE_OFF = "tableservice_off",
    BOTH_ON = "both_on",
    BOTH_OFF = "both_off",
}

export enum TypeDayEnum {
    MONDAY = "monday",
    TUESDAY = "tuesday",
    WEDNESDAY = "wednesday",
    THURSDAY = "thursday",
    FRIDAY = "friday",
    SATURDAY = "saturday",
    SUNDAY = "sunday",
}

export enum TypeDayTypeEnum {
    REGULAR = "regular",
    HOLIDAY = "holiday",
    EVENT = "event",
}
