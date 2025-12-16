export const env = {
    JWT_SECRET: process.env.JWT_SECRET!,
    MONGODB_URI: process.env.MONGODB_URI!,
    MONGODB_USER: process.env.MONGODB_USER!,
    MONGODB_PASS: process.env.MONGODB_PASS!,
    CONNECTIONS_TABLE: process.env.CONNECTIONS_TABLE!,
    WEBSOCKET_DOMAIN: process.env.WEBSOCKET_DOMAIN!,
    WEBSOCKET_STAGE: process.env.WEBSOCKET_STAGE!,
    API_GW_WS_ENDPOINT: process.env.API_GW_WS_ENDPOINT || '',
    WEBSOCKET_API_ENDPOINT: process.env.WEBSOCKET_API_ENDPOINT || '',
};

if (!env.JWT_SECRET || !env.MONGODB_URI || !env.CONNECTIONS_TABLE) {
    // eslint-disable-next-line no-console
    console.warn('Missing required env vars: JWT_SECRET, MONGO_URI, CONNECTIONS_TABLE');
}
