import jwt from "jsonwebtoken";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ConnectEvent } from "../src/handlers/connect";
import { handler } from "../src/handlers/websocket";
import { DynamoConnectionRepository } from "../src/repositories/connections-repository";
import { publishToUser } from "../src/services/publisher-service";
import { passwordChangedSince } from "../src/services/session-service";
import { PostToConnectionStatus } from "../src/types";
import { closeConnection, postToConnection } from "../src/utils/api-gw";

const mockSend = jest.fn<Promise<unknown>, [unknown]>();
const mockFindUser = jest.fn<Promise<unknown>, [string]>();
const mockUpdateCommands = jest.fn<Promise<unknown>, [CommandFilter, unknown]>();

jest.mock("../src/env", () => ({ env: { JWT_SECRET: "test-secret", CONNECTIONS_TABLE: "connections" } }));
jest.mock("../src/infra/ddb", () => ({
    docClient: { send: (command: unknown) => mockSend(command) },
    checkTable: jest.fn(),
}));
jest.mock("../src/db/mongo", () => ({ connectMongo: jest.fn() }));
jest.mock("../src/models/user", () => ({ UserModel: { findById: mockUserQuery } }));
jest.mock("../src/models/user-command", () => ({
    UserCommandModel: { updateMany: (filter: CommandFilter, update: unknown) => mockUpdateCommands(filter, update) },
}));
jest.mock("../src/utils/api-gw", () => ({
    makeManagementClient: jest.fn(),
    postToConnection: jest.fn(),
    closeConnection: jest.fn(),
}));

type UserQuery = { select: () => UserQuery; lean: () => Promise<unknown> };
type CommandFilter = { _id: { $in: unknown[] }; user_id?: string };
type StoredCommand = { _id: string; user_id: string; executed: boolean };

function mockUserQuery(id: string): UserQuery {
    return { select: () => mockUserQuery(id), lean: () => mockFindUser(id) };
}

const CONNECTION_ID = "conn-1";
const OWNER_ID = "64b000000000000000000001";
const OTHER_ID = "64b000000000000000000002";
const OWNER_KEY = { pk: `CONN#${CONNECTION_ID}`, sk: "OWNER" };
const PUSH_KEY = { pk: `USER#${OWNER_ID}`, sk: `CONN#${CONNECTION_ID}` };

// The clock stands still in every test, so expiry times compare exactly
const NOW = 1767225600;

let ownerItem: Record<string, unknown> | undefined;
let account: { status?: string; sessions_valid_after?: Date };
let commands: StoredCommand[];

const liveOwner = () => ({ ...OWNER_KEY, userId: OWNER_ID, authTime: NOW - 30, ttl: NOW + 600 });

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
    return jwt.sign({ _id: OWNER_ID, username: "owner", exp: NOW + 3600, ...claims }, "test-secret");
}

function sent<T>(type: new (...args: never[]) => T): T[] {
    return mockSend.mock.calls.map(([command]) => command).filter((command): command is T => command instanceof type);
}

const putItems = () => sent(PutCommand).map(({ input }) => input.Item);
const deletedKeys = () => sent(DeleteCommand).map(({ input }) => input.Key);

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    ownerItem = undefined;
    account = { status: "active" };
    mockSend.mockImplementation(async (command) => (command instanceof GetCommand ? { Item: ownerItem } : {}));
    mockFindUser.mockImplementation(async (id) => (id === OWNER_ID ? account : null));
    commands = [];
    // Marks what Mongo would: the listed ids, and of those only the filter's user's when it names one
    mockUpdateCommands.mockImplementation(async (filter) => {
        for (const command of commands) {
            const listed = filter._id.$in.includes(command._id);
            if (listed && (filter.user_id === undefined || filter.user_id === command.user_id)) {
                command.executed = true;
            }
        }
        return {};
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("$connect", () => {
    it("refuses an account that is no longer active", async () => {
        account = { status: "inactive" };

        const response = await connect(signToken({ auth_time: NOW }));

        expect(response).toMatchObject({ statusCode: 401 });
        expect(putItems()).toEqual([]);
    });

    it.each([
        ["is banned", { status: "banned" }],
        ["has no status", {}],
    ])("refuses an account that %s", async (_, state) => {
        account = state;

        const response = await connect(signToken({ auth_time: NOW }));

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
        const cutoff = NOW - 60;
        account = { status: "active", sessions_valid_after: new Date(cutoff * 1000) };

        expect(await connect(signToken({ iat: cutoff - 1 }))).toMatchObject({ statusCode: 401 });
        expect(await connect(signToken({ iat: cutoff + 1 }))).toMatchObject({ statusCode: 200 });
    });

    it("does not fall back to iat when auth_time is there but is not a number", async () => {
        account = { status: "active", sessions_valid_after: new Date((NOW - 60) * 1000) };

        const response = await connect(signToken({ auth_time: String(NOW), iat: NOW }));

        expect(response).toMatchObject({ statusCode: 401 });
    });

    it("writes the user's connection and its owner for a current session", async () => {
        account = { status: "active", sessions_valid_after: new Date(Date.now() - 60_000) };
        const authTime = NOW;
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

    it("keeps the user's item for 150 seconds, and the owner until the token expires but two hours at most", async () => {
        await connect(signToken({ auth_time: NOW, exp: NOW + 10 * 60 * 60 }));

        expect(putItems()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ ...PUSH_KEY, ttl: NOW + 150 }),
                expect.objectContaining({ ...OWNER_KEY, ttl: NOW + 2 * 60 * 60 }),
            ])
        );
    });

    it("lets neither item outlive a token that expires sooner", async () => {
        await connect(signToken({ auth_time: NOW, exp: NOW + 30 }));

        expect(putItems().map((item) => item?.ttl)).toEqual([NOW + 30, NOW + 30]);
    });
});

// Both panels' heartbeat sends {type: "ping"}; {action: "ping"} is the shape API Gateway routes on
describe.each(["action", "type"])("a ping sent as {%s: \"ping\"}", (field) => {
    const ping = (userId: string) =>
        handler(wsEvent("$default", "MESSAGE", { body: JSON.stringify({ [field]: "ping", userId }) }));

    it("renews only the connection's owner, whatever user id the message names", async () => {
        ownerItem = liveOwner();

        await ping(OTHER_ID);

        expect(putItems()).toEqual([expect.objectContaining({ ...PUSH_KEY, userId: OWNER_ID })]);
        expect(postToConnection).toHaveBeenCalledWith(undefined, CONNECTION_ID, expect.objectContaining({ type: "pong" }));
        expect(closeConnection).not.toHaveBeenCalled();
    });

    it("keeps the user's item 150 seconds past the ping, and never past the owner's expiry", async () => {
        ownerItem = { ...liveOwner(), ttl: NOW + 600 };
        await ping(OWNER_ID);
        ownerItem = { ...liveOwner(), ttl: NOW + 30 };
        await ping(OWNER_ID);

        expect(putItems().map((item) => item?.ttl)).toEqual([NOW + 150, NOW + 30]);
    });

    it("renews nobody for a connection with no owner, and closes it", async () => {
        await ping(OTHER_ID);

        expect(putItems()).toEqual([]);
        expect(closeConnection).toHaveBeenCalledWith(undefined, CONNECTION_ID);
    });

    it("renews nobody once the owner has expired, even though DynamoDB has not removed it yet", async () => {
        ownerItem = { ...liveOwner(), ttl: NOW - 1 };

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

describe("user-commands-ack", () => {
    const OWN_COMMAND = "65c000000000000000000001";
    const OTHERS_COMMAND = "65c000000000000000000002";
    const ack = (commandIds: unknown[]) =>
        handler(
            wsEvent("user-commands-ack", "MESSAGE", {
                body: JSON.stringify({ action: "user-commands-ack", commandIds }),
            })
        );

    beforeEach(() => {
        commands = [
            { _id: OWN_COMMAND, user_id: OWNER_ID, executed: false },
            { _id: OTHERS_COMMAND, user_id: OTHER_ID, executed: false },
        ];
    });

    it("marks the owner's command executed and leaves another user's command alone", async () => {
        ownerItem = liveOwner();

        await ack([OWN_COMMAND, OTHERS_COMMAND]);

        expect(commands.map(({ executed }) => executed)).toEqual([true, false]);
    });

    it("writes nothing for a connection with no owner, and closes it", async () => {
        await ack([OWN_COMMAND]);

        expect(mockUpdateCommands).not.toHaveBeenCalled();
        expect(closeConnection).toHaveBeenCalledWith(undefined, CONNECTION_ID);
    });

    it("writes nothing once a later password change has ended the session", async () => {
        const cutoff = new Date((NOW - 10) * 1000);
        ownerItem = { ...liveOwner(), authTime: NOW - 11 };
        account = { status: "active", sessions_valid_after: cutoff };

        await ack([OWN_COMMAND]);

        expect(mockUpdateCommands).not.toHaveBeenCalled();
        expect(deletedKeys()).toEqual(expect.arrayContaining([PUSH_KEY, OWNER_KEY]));
        expect(closeConnection).toHaveBeenCalledWith(undefined, CONNECTION_ID);
    });

    it("takes only command ids, and at most a hundred of them", async () => {
        ownerItem = liveOwner();
        const many = Array.from({ length: 150 }, (_, i) => `65c${String(i).padStart(21, "0")}`);

        await ack([{ $ne: null }, "not-an-id", ...many]);

        expect(mockUpdateCommands).toHaveBeenCalledWith(
            { _id: { $in: many.slice(0, 100) }, user_id: OWNER_ID },
            expect.anything()
        );
    });
});

describe("listByUser", () => {
    it("asks only for connections whose ttl has not passed, as DynamoDB deletes expired items days late", async () => {
        await DynamoConnectionRepository.listByUser(OWNER_ID);

        expect(sent(QueryCommand).map(({ input }) => input)).toEqual([
            expect.objectContaining({
                KeyConditionExpression: "pk = :pk",
                FilterExpression: "#ttl > :now",
                ExpressionAttributeNames: { "#ttl": "ttl" },
                ExpressionAttributeValues: { ":pk": `USER#${OWNER_ID}`, ":now": NOW },
            }),
        ]);
    });
});

describe("publishToUser", () => {
    beforeEach(() => {
        mockSend.mockImplementation(async (command) =>
            command instanceof QueryCommand ? { Items: [{ connectionId: CONNECTION_ID }] } : {}
        );
    });

    it("deletes both of a connection's items when API Gateway answers that it is gone", async () => {
        jest.mocked(postToConnection).mockResolvedValue(PostToConnectionStatus.GONE);

        await publishToUser(OWNER_ID, { type: "user-command" });

        expect(deletedKeys()).toHaveLength(2);
        expect(deletedKeys()).toEqual(expect.arrayContaining([PUSH_KEY, OWNER_KEY]));
    });

    it("keeps a connection that took the push", async () => {
        jest.mocked(postToConnection).mockResolvedValue(PostToConnectionStatus.OK);

        await publishToUser(OWNER_ID, { type: "user-command" });

        expect(deletedKeys()).toEqual([]);
    });
});

describe("$disconnect", () => {
    it("removes the user's connection and its owner", async () => {
        ownerItem = liveOwner();

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

    it("rounds the sign-in time to its nearest millisecond, as the API does", () => {
        const cutoffMs = account.sessions_valid_after.getTime();

        expect(passwordChangedSince(account, (cutoffMs - 0.4) / 1000)).toBe(false);
        expect(passwordChangedSince(account, (cutoffMs - 0.6) / 1000)).toBe(true);
    });

    it("ends a session with no known sign-in time only when there is a cut-off", () => {
        expect(passwordChangedSince(account, null)).toBe(true);
        expect(passwordChangedSince({}, null)).toBe(false);
    });
});
