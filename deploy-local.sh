export CONNECTIONS_TABLE=websocket-lambda-connections-dev
export AWS_REGION=us-east-1

npx serverless@3 offline --httpPort 4000 --websocketPort 4001 --lambdaPort 4002
