import { PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../infra/ddb";
import { env } from "../env";

const TTL_SECONDS = 60; // 5 * 60;

//  - PK (HASH) = "pk" (S)
//  - SK (RANGE) = "sk" (S)
export const DynamoConnectionRepository = {
    async put(userId: string, connectionId: string) {
        console.log(
            `[DynamoConnectionRepository].put(): table name ${env.CONNECTIONS_TABLE}`
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
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
            })
        );
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
        await docClient.send(
            new DeleteCommand({
                TableName: env.CONNECTIONS_TABLE,
                Key: {
                    pk: `USER#${userId}`,
                    sk: `CONN#${connectionId}`,
                },
            })
        );
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
};
