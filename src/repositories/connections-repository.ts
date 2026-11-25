import { PutCommand, DeleteCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../infra/ddb";
import { env } from "../env";
import {ScanCommand} from "@aws-sdk/client-dynamodb";

const TTL_SECONDS = 60; // 5 * 60;

/** Who a connection belongs to, as the token verified on $connect says. */
export type ConnectionOwner = {
    userId: string;
    /** When the token's session signed in, in epoch seconds; null when the token does not say. */
    authTime: number | null;
    /** Epoch seconds after which the connection no longer speaks for this user. */
    expiresAt: number;
};

const ownerKey = (connectionId: string) => ({ pk: `CONN#${connectionId}`, sk: "OWNER" });

//  - PK (HASH) = "pk" (S)
//  - SK (RANGE) = "sk" (S)
// Two items per connection: USER#<userId>/CONN#<connectionId>, which publishToUser lists, and
// CONN#<connectionId>/OWNER, which says whose connection it is.
export const DynamoConnectionRepository = {
    async put(owner: ConnectionOwner, connectionId: string) {
        console.log(
            `[DynamoConnectionRepository].put(): table name ${env.CONNECTIONS_TABLE}`
        );
        const nowSecs = Math.floor(Date.now() / 1000);
        const ttl = nowSecs + TTL_SECONDS;
        const { userId } = owner;

        await Promise.all([
            docClient.send(
                new PutCommand({
                    TableName: env.CONNECTIONS_TABLE,
                    Item: {
                        pk: `USER#${userId}`,
                        sk: `CONN#${connectionId}`,
                        userId,
                        connectionId,
                        ttl,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                })
            ),
            // Pings renew only the user's item; the owner holds until owner.expiresAt
            docClient.send(
                new PutCommand({
                    TableName: env.CONNECTIONS_TABLE,
                    Item: {
                        ...ownerKey(connectionId),
                        userId,
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

    async renew(userId: string, connectionId: string) {
        console.log(
            `[DynamoConnectionRepository].renew(): userId=${userId}, connectionId=${connectionId}`
        );
        const nowSecs = Math.floor(Date.now() / 1000);
        const ttl = nowSecs + TTL_SECONDS;

        await docClient.send(
            new PutCommand({
                TableName: env.CONNECTIONS_TABLE,
                Item: {
                    pk: `USER#${userId}`,
                    sk: `CONN#${connectionId}`,
                    userId,
                    connectionId,
                    ttl,
                    updatedAt: new Date().toISOString(),
                },
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
                    Key: {
                        pk: `USER#${userId}`,
                        sk: `CONN#${connectionId}`,
                    },
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
            ExpressionAttributeValues: { ":pk": `USER#${userId}` },
            ProjectionExpression: "connectionId",
            // ConsistentRead: true, // Consistent read
        }));
        return (out.Items || []).map((i: any) => i.connectionId as string);
    },

    async listAll(): Promise<string[]> {
        const out = await docClient.send(new ScanCommand({
            TableName: env.CONNECTIONS_TABLE,
            ProjectionExpression: "connectionId",
        }));
        return (out.Items || []).map((i: any) => i.connectionId as string);
    },
};
