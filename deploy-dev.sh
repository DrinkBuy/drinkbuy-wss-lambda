export API_GW_WS_ENDPOINT="https://2n19vx2n73.execute-api.us-east-1.amazonaws.com/publish"
export WEBSOCKET_DOMAIN="k3wf2d7qqg.execute-api.us-east-1.amazonaws.com"
export WEBSOCKET_STAGE="dev"

npx serverless deploy --stage dev --aws-profile drink-root
