import jwt from "jsonwebtoken";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { ConnectEvent } from "../src/handlers/connect";
import { handler } from "../src/handlers/websocket";
import { passwordChangedSince } from "../src/services/session-service";

const mockSend = jest.fn<Promise<unknown>, [unknown]>();
const mockFindUser = jest.fn<Promise<unknown>, [string]>();

jest.mock("../src/env", () => ({ env: { JWT_SECRET: "test-secret", CONNECTIONS_TABLE: "connections" } }));
jest.mock("../src/infra/ddb", () => ({
    docClient: { send: (command: unknown) => mockSend(command) },
    checkTable: jest.fn(),
}));
jest.mock("../src/db/mongo", () => ({ connectMongo: jest.fn() }));
jest.mock("../src/models/user", () => ({ UserModel: { findById: mockUserQuery } }));

type UserQuery = { select: () => UserQuery; lean: () => Promise<unknown> };

function mockUserQuery(id: string): UserQuery {
    return { select: () => mockUserQuery(id), lean: () => mockFindUser(id) };
}

const CONNECTION_ID = "conn-1";
const OWNER_ID = "64b000000000000000000001";
const PUSH_KEY = { pk: `USER#${OWNER_ID}`, sk: `CONN#${CONNECTION_ID}` };

const nowSecs = () => Math.floor(Date.now() / 1000);

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

function signToken(claims: object) {
    return jwt.sign({ _id: OWNER_ID, username: "owner", exp: nowSecs() + 3600, ...claims }, "test-secret");
}

function sent<T>(type: new (...args: never[]) => T): T[] {
    return mockSend.mock.calls.map(([command]) => command).filter((command): command is T => command instanceof type);
}

const putItems = () => sent(PutCommand).map(({ input }) => input.Item);

beforeEach(() => {
    jest.clearAllMocks();
    account = { status: "active" };
    mockSend.mockResolvedValue({});
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

    it("maps the connection to the user for a current session", async () => {
        account = { status: "active", sessions_valid_after: new Date(Date.now() - 60_000) };

        const response = await connect(signToken({ auth_time: nowSecs() }));

        expect(response).toMatchObject({ statusCode: 200 });
        expect(putItems()).toEqual([expect.objectContaining({ ...PUSH_KEY, userId: OWNER_ID })]);
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
