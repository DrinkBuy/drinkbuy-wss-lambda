import {
    DynamoDBClient,
    DescribeTableCommand,
    CreateTableCommand,
    ScanCommand,
} from "@aws-sdk/client-dynamodb";

import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const region =
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1";

const baseClient = new DynamoDBClient({
    region,
});

export const docClient = DynamoDBDocumentClient.from(baseClient, {
    marshallOptions: { removeUndefinedValues: true },
});

export async function checkTable(tableName: string) {
    try {
        const desc = await baseClient.send(
            new DescribeTableCommand({ TableName: tableName })
        );
        console.log("[DDB].checkTable(): DYNAMO TABLE EXISTS", tableName, desc.Table?.TableStatus);
    } catch (error) {
        console.log("[DDB].checkTable(): DYNAMO CREATING TABLE", tableName, error);
        await baseClient.send(
            new CreateTableCommand({
                TableName: tableName,
                BillingMode: "PAY_PER_REQUEST",
                AttributeDefinitions: [
                    { AttributeName: "pk", AttributeType: "S" },
                    { AttributeName: "sk", AttributeType: "S" },
                ],
                KeySchema: [
                    { AttributeName: "pk", KeyType: "HASH" },
                    { AttributeName: "sk", KeyType: "RANGE" },
                ],
            })
        );
        console.log("[DDB].checkTable(): DYNAMO TABLE CREATED", tableName);
    }
}

export async function scanTable(tableName: string) {
    try {
        const result = await baseClient.send(
            new ScanCommand({
                TableName: tableName,
            })
        );
        console.log("[DDB].scanTable(): ITEMS COUNT", result.Count);
        return result.Items;
    } catch (error: any) {
        console.error("[DDB].scanTable(): ERROR", error);
        return [];
    }
}
