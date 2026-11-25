import jwt from "jsonwebtoken";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handlers/http-publish";
import { publishCommandAndFanOut } from "../src/services/publisher-service";

const mockFindUser = jest.fn<Promise<unknown>, [string]>();
const mockFindAllUsers = jest.fn<Promise<unknown[]>, []>();
const mockSaveCommand = jest.fn<Promise<unknown>, [Record<string, unknown>]>();

jest.mock("../src/env", () => ({ env: { JWT_SECRET: "test-secret" } }));
jest.mock("../src/db/mongo", () => ({ connectMongo: jest.fn() }));
jest.mock("../src/models/user", () => ({
    UserModel: {
        findById: mockUserQuery,
        find: () => ({ select: () => ({ lean: () => ({ exec: () => mockFindAllUsers() }) }) }),
    },
}));
jest.mock("../src/models/user-command", () => ({
    UserCommandModel: class {
        constructor(private readonly doc: Record<string, unknown>) {}
        save() {
            return mockSaveCommand(this.doc);
        }
    },
}));
jest.mock("../src/services/publisher-service", () => ({ publishCommandAndFanOut: jest.fn() }));

type UserQuery = { select: () => UserQuery; lean: () => Promise<unknown> };

function mockUserQuery(id: string): UserQuery {
    return { select: () => mockUserQuery(id), lean: () => mockFindUser(id) };
}

type Account = { _id: string; username: string; role: string; status?: string; sessions_valid_after?: Date };

const NOW = 1767225600;
const ADMIN_ID = "64a000000000000000000001";
const BAR_USER_ID = "64a000000000000000000002";
const OTHER_ID = "64a000000000000000000003";

let accounts: Account[];

const savedCommands = () => mockSaveCommand.mock.calls.map(([doc]) => doc);

function signToken(userId: string, claims: object = {}, secret = "test-secret") {
    return jwt.sign({ _id: userId, username: "whoever", auth_time: NOW - 60, exp: NOW + 3600, ...claims }, secret);
}

function publish(body: object, authorization?: string) {
    const event: APIGatewayProxyEventV2 = {
        version: "2.0",
        routeKey: "POST /publish-command",
        rawPath: "/publish-command",
        rawQueryString: "",
        headers: authorization === undefined ? {} : { authorization },
        requestContext: {
            accountId: "account-1",
            apiId: "api-1",
            domainName: "publish.example.test",
            domainPrefix: "publish",
            http: {
                method: "POST",
                path: "/publish-command",
                protocol: "HTTP/1.1",
                sourceIp: "127.0.0.1",
                userAgent: "jest",
            },
            requestId: "request-1",
            routeKey: "POST /publish-command",
            stage: "$default",
            time: "",
            timeEpoch: 0,
        },
        isBase64Encoded: false,
        body: JSON.stringify(body),
    };
    return handler(event);
}

const toAll = { user_id: "ALL", scope: "global", command: "RELOAD" };
const orderRefresh = (userId: string) => ({
    user_id: userId,
    username: "spoofed",
    scope: "user",
    command: "ACTIVE_ORDER_REFRESH",
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    accounts = [
        { _id: ADMIN_ID, username: "admin", role: "drinkbuy_admin", status: "active" },
        { _id: BAR_USER_ID, username: "bar", role: "bar_manager", status: "active" },
        { _id: OTHER_ID, username: "other", role: "bartender", status: "active" },
    ];
    mockFindUser.mockImplementation(async (id) => accounts.find(({ _id }) => _id === id) ?? null);
    mockFindAllUsers.mockImplementation(async () => accounts);
    mockSaveCommand.mockImplementation(async (doc) => ({ _id: `command-${mockSaveCommand.mock.calls.length}`, ...doc }));
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("POST /publish-command from a DrinkBuy admin", () => {
    it("publishes to ALL users", async () => {
        const response = await publish(toAll, `Bearer ${signToken(ADMIN_ID)}`);

        expect(response).toMatchObject({ statusCode: 201 });
        expect(savedCommands().map(({ user_id }) => user_id)).toEqual([ADMIN_ID, BAR_USER_ID, OTHER_ID]);
        expect(publishCommandAndFanOut).toHaveBeenCalledTimes(3);
    });

    it("publishes to one user under the username the database holds, not the body's", async () => {
        const response = await publish(
            { user_id: OTHER_ID, username: "spoofed", scope: "user", command: "LOGOUT" },
            `Bearer ${signToken(ADMIN_ID)}`
        );

        expect(response).toMatchObject({ statusCode: 201 });
        expect(savedCommands()).toEqual([expect.objectContaining({ user_id: OTHER_ID, username: "other" })]);
    });

    it("refuses an expired token with 401", async () => {
        const response = await publish(toAll, `Bearer ${signToken(ADMIN_ID, { exp: NOW - 1 })}`);

        expect(response).toMatchObject({ statusCode: 401 });
        expect(savedCommands()).toEqual([]);
    });

    it.each([
        ["an account that is no longer active", { status: "inactive" }],
        ["a session from before the last password change", { sessions_valid_after: new Date((NOW - 30) * 1000) }],
    ])("refuses %s with 401", async (_, change) => {
        accounts[0] = { ...accounts[0], ...change };

        const response = await publish(toAll, `Bearer ${signToken(ADMIN_ID)}`);

        expect(response).toMatchObject({ statusCode: 401 });
        expect(savedCommands()).toEqual([]);
    });

    it.each([
        ["an unknown command", { ...toAll, command: "FORMAT_DISK" }],
        ["an unknown scope", { ...toAll, scope: "planet" }],
        ["a user id that is not one", { ...toAll, user_id: "someone" }],
    ])("answers 400 for %s", async (_, body) => {
        const response = await publish(body, `Bearer ${signToken(ADMIN_ID)}`);

        expect(response).toMatchObject({ statusCode: 400 });
        expect(savedCommands()).toEqual([]);
    });
});

describe("POST /publish-command with a token that is not an admin's", () => {
    it("accepts the API's refresh of the token user's own orders, even once the token has expired", async () => {
        const response = await publish(
            orderRefresh(BAR_USER_ID),
            `Bearer ${signToken(BAR_USER_ID, { exp: NOW - 24 * 60 * 60 })}`
        );

        expect(response).toMatchObject({ statusCode: 201 });
        expect(savedCommands()).toEqual([
            expect.objectContaining({
                user_id: BAR_USER_ID,
                username: "bar",
                scope: "user",
                command: "ACTIVE_ORDER_REFRESH",
            }),
        ]);
    });

    it.each([
        ["to ALL users", toAll],
        ["any other command to itself", { ...orderRefresh(BAR_USER_ID), command: "RELOAD" }],
        ["an order refresh in another scope", { ...orderRefresh(BAR_USER_ID), scope: "tenant" }],
        ["an order refresh for another user", orderRefresh(OTHER_ID)],
    ])("refuses publishing %s with 403", async (_, body) => {
        const response = await publish(body, `Bearer ${signToken(BAR_USER_ID)}`);

        expect(response).toMatchObject({ statusCode: 403 });
        expect(savedCommands()).toEqual([]);
    });
});

describe("POST /publish-command without a valid token", () => {
    it.each([
        ["no Authorization header", undefined],
        ["an empty Bearer", "Bearer "],
        ["a token signed with another secret", `Bearer ${signToken(ADMIN_ID, {}, "another-secret")}`],
        ["a token that is not a JWT", "Bearer not-a-jwt"],
    ])("refuses %s with 401", async (_, authorization) => {
        const response = await publish(toAll, authorization);

        expect(response).toMatchObject({ statusCode: 401 });
        expect(savedCommands()).toEqual([]);
    });

    it("refuses a self refresh signed with another secret with 401", async () => {
        const response = await publish(
            orderRefresh(BAR_USER_ID),
            `Bearer ${signToken(BAR_USER_ID, {}, "another-secret")}`
        );

        expect(response).toMatchObject({ statusCode: 401 });
        expect(savedCommands()).toEqual([]);
    });
});
