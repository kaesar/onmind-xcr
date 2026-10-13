// OnMind-XCR stack: one Lambda (Hono app) fronted by an HTTP API (API Gateway v2)
// backed by an S3 bucket (blobs + manifests + xrepos.json, same key layout as
// the filesystem backend). The Lambda code is an ASSET of the REPO ROOT
// (the same tree the Bun container runs), so `src/lambda.handler` +
// node_modules ship as-is — no bundling step.
//
// Auth is enforced by the app, not the gateway (same parity idea as XPS):
// XCR_API_KEY via x-api-key header or Basic password (except /health,
// GET /v2/). No usage plan on HTTP API v2.
//
// Lambda is stateless: XCR_STORAGE is always `s3` here (filesystem mode is
// local-only). Payloads flow through API Gateway + Lambda, so single-digit-MB
// blobs and the 30s integration timeout apply — large layers belong on the
// container runtime (fase 2: presigned-URL uploads straight to S3).
//
// Config is CDK context (cdk.json defaults, overridable with -c key=value):
//   apiKey           OPTIONAL: XCR_API_KEY. Prefer the XCR_API_KEY env var so
//                    the secret never hits argv/shell history. Empty = open
//                    API (fine for Floci/throwaway; set it in prod).
//   bucketPrefix     prepended to xcr-registry (multi-env accounts)
//   xcrEnv           XCR_ENV for the app (default production)
//   removalPolicy    retain (default, prod) | destroy (throwaway/Floci envs)
//   corsOrigins      comma list → XCR_CORS_ORIGINS
//   localEndpoint    emulator URL (Floci/LocalStack/RustFS) → AWS_ENDPOINT_URL +
//                    XCR_S3_ENDPOINT inside the Lambda
'use strict'
const path = require('node:path')
const cdk = require('aws-cdk-lib')
const lambda = require('aws-cdk-lib/aws-lambda')
const s3 = require('aws-cdk-lib/aws-s3')
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2')
const { HttpLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations')
const logs = require('aws-cdk-lib/aws-logs')

const REPO_ROOT = path.join(__dirname, '..', '..')

function ctx(stack, key, def = '') {
  const v = stack.node.tryGetContext(key)
  return v === undefined || v === null || v === '' ? def : v
}

function ctxList(stack, key) {
  return String(ctx(stack, key, ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

class XcrStack extends cdk.Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props)

    const bucketPrefix = String(ctx(this, 'bucketPrefix', ''))
    const removal =
      String(ctx(this, 'removalPolicy', 'retain')).toLowerCase() === 'destroy'
        ? cdk.RemovalPolicy.DESTROY
        : cdk.RemovalPolicy.RETAIN

    // ---------- S3 ----------
    // Layout must match src/s3Store.js: <prefix>blobs/sha256/aa/<hex>,
    // <prefix>manifests/sha256/aa/<hex>, <prefix>uploads/<uuid>/*,
    // <prefix>xrepos.json. Blobs are immutable by digest; xrepos.json is the
    // only mutable object (single-writer v1). No versioning by default
    // (every xrepos.json write would stack a version); enable it later if
    // audit history is worth the cost.
    const registryBucket = new s3.Bucket(this, 'xcrRegistryBucket', {
      bucketName: `${bucketPrefix}xcr-registry`.toLowerCase() || undefined,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: removal,
      autoDeleteObjects: removal === cdk.RemovalPolicy.DESTROY,
    })

    // ---------- Lambda env ----------
    // XCR_API_KEY is optional at synth: empty means the API runs open —
    // fine for Floci/throwaway, set it for prod. Prefer the XCR_API_KEY
    // env var so the secret never hits argv/history.
    const apiKey = process.env.XCR_API_KEY || String(ctx(this, 'apiKey', ''))

    const fnEnv = {
      XCR_ENV: String(ctx(this, 'xcrEnv', 'production')),
      XCR_STORAGE: 's3',
      XCR_S3_BUCKET: registryBucket.bucketName,
      XCR_S3_PREFIX: 'docker-registry/',
    }
    if (apiKey) fnEnv.XCR_API_KEY = apiKey
    const cors = ctxList(this, 'corsOrigins')
    if (cors.length) fnEnv.XCR_CORS_ORIGINS = cors.join(',')

    // Floci/LocalStack/RustFS: SDK v3 resolves AWS_ENDPOINT_URL globally;
    // storage additionally honours XCR_S3_ENDPOINT (both set for belt
    // and braces) with path-style forced by the app when an endpoint is set.
    const localEndpoint = String(ctx(this, 'localEndpoint', ''))
    if (localEndpoint) {
      fnEnv.AWS_ENDPOINT_URL = localEndpoint
      fnEnv.XCR_S3_ENDPOINT = localEndpoint
      fnEnv.XCR_S3_FORCE_PATH_STYLE = 'true'
    }

    // ---------- Lambda ----------
    const xcrFn = new lambda.Function(this, 'XcrFunction', {
      description: 'OnMind-XCR container registry (Hono, HTTP API only, S3 backend)',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'src/lambda.handler',
      // Repo-root asset: keep in sync with the tree the Bun container runs.
      code: lambda.Code.fromAsset(REPO_ROOT, {
        exclude: [
          '.git',
          '.github',
          'cdk', // this CDK app + its node_modules
          'PLAN.md',
          'xcr-data', // local throwaway data, never ship
          '.env',
          '.dev.vars',
          '*.log',
          'bun.lock',
        ],
      }),
      // Blobs/manifests buffer in memory per request (v1, no streaming).
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      environment: fnEnv,
      // Explicit log group (retention set here; `logRetention` is deprecated).
      logGroup: new logs.LogGroup(this, 'XcrLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: removal,
      }),
    })
    registryBucket.grantReadWrite(xcrFn)

    // ---------- HTTP API ----------
    // Payload format 2.0: binary bodies (octet-stream layers, manifests)
    // arrive base64-encoded with isBase64Encoded; hono/aws-lambda decodes
    // before app.fetch, so arrayBuffer() sees raw bytes. No binary-media
    // config needed (that's a REST-API concept).
    const api = new apigwv2.HttpApi(this, 'XcrHttpApi', {
      apiName: `${bucketPrefix}xcr-api`,
      description: 'OnMind-XCR API (OCI registry + ECR subset)',
    })

    const integration = new HttpLambdaIntegration('LambdaIntegration', xcrFn)
    api.addRoutes({ path: '/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration })
    api.addRoutes({ path: '/', methods: [apigwv2.HttpMethod.ANY], integration })

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.apiEndpoint,
      description: 'Base URL (registry + ECR-subset entry point)',
    })
    new cdk.CfnOutput(this, 'ApiId', {
      value: api.apiId,
      description: 'HTTP API id (for future custom-domain ApiMapping)',
    })
    new cdk.CfnOutput(this, 'FunctionName', { value: xcrFn.functionName })
    new cdk.CfnOutput(this, 'RegistryBucket', { value: registryBucket.bucketName })
  }
}

module.exports = { XcrStack }
