import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";

// AWS Lambda (Node.js 24): handler `src/lambda.handler`.
// Env: XCR_STORAGE=s3, XCR_S3_BUCKET (required), XCR_S3_PREFIX, XCR_S3_ENDPOINT,
// XCR_API_KEY (behind API Gateway). Lambda is stateless: filesystem mode unsupported.
const app = createApp(process.env);
export const handler = handle(app);
