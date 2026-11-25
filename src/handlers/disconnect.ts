import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { DynamoConnectionRepository } from '../repositories/connections-repository';

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
    const { connectionId } = event.requestContext;

    // The owner item names the user, so the user's item is found without a scan. A connection
    // opened before owners existed has none; its item goes on the next push that fails.
    const owner = await DynamoConnectionRepository.findOwner(connectionId);
    if (owner) {
        await DynamoConnectionRepository.delete(owner.userId, connectionId);
    }

    console.log('Disconnected', { connectionId });

    return {
        statusCode: 200,
        body: 'Disconnected'
    };
};
