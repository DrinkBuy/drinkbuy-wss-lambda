import { PutCommand, DeleteCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../infra/ddb";
import { env } from "../env";

// The panels ping every 30 s, but Chrome runs the timers of a tab hidden for 5 minutes once a
// minute at most. A minute's ttl lapsed just as that ping landed, and a push in the gap was
// filtered out; 150 s outlasts two throttled pings.
const TTL_SECONDS = 150;

/** Who a connection belongs to, as the token verified on $connect says. */
export type ConnectionOwner = {
    userId: string;
    /** When the token's session signed in, in epoch seconds; null when the token does not say. */
    authTime: number | null;
    /** Epoch seconds after which the connection no longer speaks for this user. */
    expiresAt: number;
};

const nowSecs = () => Math.floor(Date.now() / 1000);

const ownerKey = (connectionId: string) => ({ pk: `CONN#${connectionId}`, sk: "OWNER" });
const pushKey = (userId: string, connectionId: string) => ({ pk: `USER#${userId}`, sk: `CONN#${connectionId}` });

/** The item publishToUser lists: it lasts TTL_SECONDS past the last ping, and never past its owner. */
function pushItem(owner: ConnectionOwner, connectionId: string) {
    return {
        ...pushKey(owner.userId, connectionId),
        userId: owner.userId,
        connectionId,
        ttl: Math.min(nowSecs() + TTL_SECONDS, owner.expiresAt),
        updatedAt: new Date().toISOString(),
    };
}

//  - PK (HASH) = "pk" (S)
//  - SK (RANGE) = "sk" (S)
// Two items per connection: USER#<userId>/CONN#<connectionId>, which publishToUser lists, and
// CONN#<connectionId>/OWNER, which says whose connection it is.
export const DynamoConnectionRepository = {
    async put(owner: ConnectionOwner, connectionId: string) {
        console.log(
            `[DynamoConnectionRepository].put(): table name ${env.CONNECTIONS_TABLE}`
        );
        await Promise.all([
            docClient.send(
                new PutCommand({
                    TableName: env.CONNECTIONS_TABLE,
                    Item: { ...pushItem(owner, connectionId), createdAt: new Date().toISOString() },
                })
            ),
            // Pings renew only the user's item; the owner holds until owner.expiresAt
            docClient.send(
                new PutCommand({
                    TableName: env.CONNECTIONS_TABLE,
                    Item: {
                        ...ownerKey(connectionId),
                        userId: owner.userId,
                        connectionId,
                        authTime: owner.authTime,
                        ttl: owner.expiresAt,
                        createdAt: new Date().toISOString(),
                    },
                })
            ),
        ]);
    },

    async findOwner(connectionId: string): Promise<ConnectionOwner | null> {
        const { Item } = await docClient.send(
            new GetCommand({
                TableName: env.CONNECTIONS_TABLE,
                Key: ownerKey(connectionId),
            })
        );
        if (typeof Item?.userId !== "string" || typeof Item.ttl !== "number") {
            return null;
        }
        return {
            userId: Item.userId,
            authTime: typeof Item.authTime === "number" ? Item.authTime : null,
            expiresAt: Item.ttl,
        };
    },

    async renew(owner: ConnectionOwner, connectionId: string) {
        console.log(
            `[DynamoConnectionRepository].renew(): userId=${owner.userId}, connectionId=${connectionId}`
        );
        await docClient.send(
            new PutCommand({
                TableName: env.CONNECTIONS_TABLE,
                Item: pushItem(owner, connectionId),
            })
        );
    },

    async delete(userId: string, connectionId: string) {
        console.log(
            `[DynamoConnectionRepository].delete(): userId=${userId}, connectionId=${connectionId}`
        );
        await Promise.all([
            docClient.send(
                new DeleteCommand({
                    TableName: env.CONNECTIONS_TABLE,
                    Key: pushKey(userId, connectionId),
                })
            ),
            docClient.send(
                new DeleteCommand({
                    TableName: env.CONNECTIONS_TABLE,
                    Key: ownerKey(connectionId),
                })
            ),
        ]);
    },

    async listByUser(userId: string): Promise<string[]> {
        const out = await docClient.send(new QueryCommand({
            TableName: env.CONNECTIONS_TABLE,
            KeyConditionExpression: "pk = :pk",
            // DynamoDB deletes an expired item days late at worst; a connection that stopped
            // pinging stops receiving pushes when its ttl passes. ttl is a reserved word.
            FilterExpression: "#ttl > :now",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":now": nowSecs() },
            ProjectionExpression: "connectionId",
        }));
        return (out.Items ?? [])
            .map((item) => item.connectionId)
            .filter((connectionId): connectionId is string => typeof connectionId === "string");
    },
};
