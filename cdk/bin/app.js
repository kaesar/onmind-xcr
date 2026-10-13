#!/usr/bin/env node
// OnMind-XCR CDK app (JavaScript, CJS). See ARCHITECTURE.md.
'use strict'
const cdk = require('aws-cdk-lib')
const { XcrStack } = require('../lib/xcr-stack')

const app = new cdk.App()

const termination = app.node.tryGetContext('terminationProtection')
const terminationProtection = termination === true || termination === 'true'

new XcrStack(app, 'XcrStack', {
  description: 'OnMind-XCR: Lambda + S3 (registry blobs) + HTTP API',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  terminationProtection,
})

app.synth()
