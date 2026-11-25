import jwt from "jsonwebtoken";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { ConnectEvent } from "../src/handlers/connect";
import { handler } from "../src/handlers/websocket";
import { passwordChangedSince } from "../src/services/session-service";
import { closeConnection, postToConnection } from "../src/utils/api-gw";

const mockSend = jest.fn<Promise<unknown>, [unknown]>();
const mockFindUser = jest.fn<Promise<unknown>, [string]>();

jest.mock("../src/env", () => ({ env: { JWT_SECRET: "test-secret", CONNECTIONS_TABLE: "connections" } }));
jest.mock("../src/infra/ddb", () => ({
    docClient: { send: (command: unknown) => mockSend(command) },
    checkTable: jest.fn(),
}));
jest.mock("../src/db/mongo", () => ({ connectMongo: jest.fn() }));
jest.mock("../src/models/user", () => ({ UserModel: { findById: mockUserQuery } }));
jest.mock("../src/utils/api-gw", () => ({
    makeManagementClient: jest.fn(),
    postToConnection: jest.fn(),
    closeConnection: jest.fn(),
}));

type UserQuery = { select: () => UserQuery; lean: () => Promise<unknown> };

function mockUserQuery(id: string): UserQuery {
    return { select: () => mockUserQuery(id), lean: () => mockFindUser(id) };
}

const CONNECTION_ID = "conn-1";
const OWNER_ID = "64b000000000000000000001";
const OTHER_ID = "64b000000000000000000002";
const OWNER_KEY = { pk: `CONN#${CONNECTION_ID}`, sk: "OWNER" };
const PUSH_KEY = { pk: `USER#${OWNER_ID}`, sk: `CONN#${CONNECTION_ID}` };

const nowSecs = () => Math.floor(Date.now() / 1000);

let ownerItem: Record<string, unknown> | undefined;
let account: { status: string; sessions_valid_after?: Date };

function wsEvent(
    routeKey: string,
    eventType: "CONNECT" | "MESSAGE" | "DISCONNECT",
    extra: { body?: string; token?: string } = {}
): ConnectEvent {
    return {
        requestContext: {
            routeKey,
            eventType,
            messageId: "message-1",
            extendedRequestId: "extended-1",
            requestTime: "",
            messageDirection: "IN",
            stage: "dev",
            connectedAt: 0,
            requestTimeEpoch: 0,
            requestId: "request-1",
            domainName: "ws.example.test",
            connectionId: CONNECTION_ID,
            apiId: "api-1",
        },
        isBase64Encoded: false,
        body: extra.body,
        queryStringParameters: extra.token ? { token: extra.token } : undefined,
    };
}

const connect = (token: string) => handler(wsEvent("$connect", "CONNECT", { token }));
const disconnect = () => handler(wsEvent("$disconnect", "DISCONNECT"));

function signToken(claims: object) {
    return jwt.sign({ _id: OWNER_ID, username: "owner", exp: nowSecs() + 3600, ...claims }, "test-secret");
}

function sent<T>(type: new (...args: never[]) => T): T[] {
    return mockSend.mock.calls.map(([command]) => command).filter((command): command is T => command instanceof type);
}

const putItems = () => sent(PutCommand).map(({ input }) => input.Item);
const deletedKeys = () => sent(DeleteCommand).map(({ input }) => input.Key);

beforeEach(() => {
    jest.clearAllMocks();
    ownerItem = undefined;
    account = { status: "active" };
    mockSend.mockImplementation(async (command) => (command instanceof GetCommand ? { Item: ownerItem } : {}));
    mockFindUser.mockImplementation(async (id) => (id === OWNER_ID ? account : null));
});

describe("$connect", () => {
    it("refuses an account that is no longer active", async () => {
        account = { status: "inactive" };

        const response = await connect(signToken({ auth_time: nowSecs() }));

        expect(response).toMatchObject({ statusCode: 401 });
        expect(putItems()).toEqual([]);
    });

    it("refuses a token whose session signed in before the last password change", async () => {
        const cutoff = new Date(Date.now() - 60_000);
        account = { status: "active", sessions_valid_after: cutoff };

        const response = await connect(signToken({ auth_time: cutoff.getTime() / 1000 - 1 }));

        expect(response).toMatchObject({ statusCode: 401 });
        expect(putItems()).toEqual([]);
    });

    it("counts a token without auth_time from its iat", async () => {
        const cutoff = nowSecs() - 60;
        account = { status: "active", sessions_valid_after: new Date(cutoff * 1000) };

        expect(await connect(signToken({ iat: cutoff - 1 }))).toMatchObject({ statusCode: 401 });
        expect(await connect(signToken({ iat: cutoff + 1 }))).toMatchObject({ statusCode: 200 });
    });

    it("writes the user's connection and its owner for a current session", async () => {
        account = { status: "active", sessions_valid_after: new Date(Date.now() - 60_000) };
        const authTime = nowSecs();
        const exp = authTime + 3600;

        const response = await connect(signToken({ auth_time: authTime, exp }));

        expect(response).toMatchObject({ statusCode: 200 });
        expect(putItems()).toHaveLength(2);
        expect(putItems()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ ...PUSH_KEY, userId: OWNER_ID }),
                expect.objectContaining({ ...OWNER_KEY, userId: OWNER_ID, authTime, ttl: exp }),
            ])
        );
    });
});

// Both panels' heartbeat sends {type: "ping"}; {action: "ping"} is the shape API Gateway routes on
describe.each(["action", "type"])("a ping sent as {%s: \"ping\"}", (field) => {
    const ping = (userId: string) =>
        handler(wsEvent("$default", "MESSAGE", { body: JSON.stringify({ [field]: "ping", userId }) }));
    const liveOwner = () => ({ ...OWNER_KEY, userId: OWNER_ID, authTime: nowSecs() - 30, ttl: nowSecs() + 600 });

    it("renews only the connection's owner, whatever user id the message names", async () => {
        ownerItem = liveOwner();

        await ping(OTHER_ID);

        expect(putItems()).toEqual([expect.objectContaining({ ...PUSH_KEY, userId: OWNER_ID })]);
        expect(postToConnection).toHaveBeenCalledWith(undefined, CONNECTION_ID, expect.objectContaining({ type: "pong" }));
        expect(closeConnection).not.toHaveBeenCalled();
    });

    it("renews nobody for a connection with no owner, and closes it", async () => {
        await ping(OTHER_ID);

        expect(putItems()).toEqual([]);
        expect(closeConnection).toHaveBeenCalledWith(undefined, CONNECTION_ID);
    });

    it("renews nobody once the owner has expired, even though DynamoDB has not removed it yet", async () => {
        ownerItem = { ...liveOwner(), ttl: nowSecs() - 1 };

        await ping(OWNER_ID);

        expect(putItems()).toEqual([]);
        expect(closeConnection).toHaveBeenCalledWith(undefined, CONNECTION_ID);
    });

    it("ends a connection whose session a later password change ended", async () => {
        const cutoff = new Date(Date.now() - 10_000);
        ownerItem = { ...liveOwner(), authTime: cutoff.getTime() / 1000 - 1 };
        account = { status: "active", sessions_valid_after: cutoff };

        await ping(OWNER_ID);

        expect(putItems()).toEqual([]);
        expect(deletedKeys()).toEqual(expect.arrayContaining([PUSH_KEY, OWNER_KEY]));
        expect(closeConnection).toHaveBeenCalledWith(undefined, CONNECTION_ID);
    });
});

describe("$disconnect", () => {
    it("removes the user's connection and its owner", async () => {
        ownerItem = { ...OWNER_KEY, userId: OWNER_ID, authTime: nowSecs(), ttl: nowSecs() + 600 };

        await disconnect();

        expect(deletedKeys()).toHaveLength(2);
        expect(deletedKeys()).toEqual(expect.arrayContaining([PUSH_KEY, OWNER_KEY]));
    });
});

describe("passwordChangedSince", () => {
    const account = { sessions_valid_after: new Date(1767225600500) };

    it("compares the token's sign-in time with the cut-off to the millisecond", () => {
        expect(passwordChangedSince(account, 1767225600.499)).toBe(true);
        expect(passwordChangedSince(account, 1767225600.5)).toBe(false);
    });

    it("ends a session with no known sign-in time only when there is a cut-off", () => {
        expect(passwordChangedSince(account, null)).toBe(true);
        expect(passwordChangedSince({}, null)).toBe(false);
    });
});
