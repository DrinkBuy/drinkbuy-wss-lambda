import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
    const { requestContext } = event;
    const connectionId = requestContext.connectionId!;

    // userId is part of the PK; we don't get it on disconnect directly.
    // A simple approach is to scan by GSI, but we kept a composite PK.
    // To avoid scans, we keep userId in the query param on connecting and echo it back in the connectionId? Not available here.
    // For simplicity, do nothing here; stale connections are harmless and will be pruned on failed sending.
    // If you want perfect cleanup, model also a reverse index (pk=CONN#id, sk=USER#userId).

    console.log('Disconnected', { connectionId });

    return {
        statusCode: 200,
        body: 'Disconnected'
    };
};
