#!/usr/bin/env node
'use strict';

// Compatibility checks for the scoped security overrides. This is not an
// npm-audit allowlist: unresolved upstream advisories remain visible there.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'airchat-dependency-security-'));
  const timeout = setTimeout(() => {
    console.error('Dependency compatibility check timed out');
    process.exitCode = 1;
    process.exit(1);
  }, 15000);
  try {
    const navigationManifest = require.resolve('@react-navigation/core/package.json');
    const navigation = require(navigationManifest);
    assert.equal(navigation.dependencies['query-string'], undefined);
    const { getStateFromPath } = await import(pathToFileURL(
      path.join(path.dirname(navigationManifest), 'lib/module/getStateFromPath.js'),
    ).href);
    const options = { screens: { Chat: 'chat/:id' } };
    const good = getStateFromPath('/chat/42?q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82', options);
    assert.equal(good.routes[0].params.id, '42');
    assert.equal(good.routes[0].params.q, 'привет');
    // The old decoder's malformed-input fallback could take exponential time.
    assert.ok(getStateFromPath('/chat/42?q=' + '%FF'.repeat(10000), options));
    console.log('PASS navigation query parsing and malformed-input regression');

    const nycRequire = createRequire(require.resolve('@istanbuljs/load-nyc-config'));
    assert.match(nycRequire('js-yaml/package.json').version, /^4\./);
    const yamlFile = path.join(temporary, '.nycrc.yaml');
    await fs.writeFile(yamlFile, 'all: true\ninclude:\n  - src/**/*.ts\nreporter:\n  - text\n');
    const yaml = await require('@istanbuljs/load-nyc-config').loadNycConfig({ cwd: temporary });
    assert.equal(yaml.all, true);
    assert.deepEqual(yaml.include, ['src/**/*.ts']);
    assert.deepEqual(yaml.reporter, ['text']);
    console.log('PASS coverage YAML configuration through the real parent loader');

    const firestoreRequire = createRequire(require.resolve('@firebase/firestore/package.json'));
    assert.equal(firestoreRequire('@grpc/grpc-js/package.json').version, '1.13.6');
    const grpc = firestoreRequire('@grpc/grpc-js');
    const protoLoader = firestoreRequire('@grpc/proto-loader');
    const protoFile = path.join(temporary, 'compat.proto');
    await fs.writeFile(protoFile, 'syntax = "proto3"; package compat; service Echo { rpc Get (Message) returns (Message); } message Message { string value = 1; }');
    const descriptor = grpc.loadPackageDefinition(protoLoader.loadSync(protoFile));
    const server = new grpc.Server();
    server.addService(descriptor.compat.Echo.service, { get: (call, done) => done(null, call.request) });
    let client;
    try {
      const port = await new Promise((resolve, reject) => server.bindAsync(
        '127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
        (error, bound) => error ? reject(error) : resolve(bound),
      ));
      client = new descriptor.compat.Echo(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
      const reply = await new Promise((resolve, reject) => client.get(
        { value: 'compatibility' }, { deadline: Date.now() + 5000 },
        (error, value) => error ? reject(error) : resolve(value),
      ));
      assert.equal(reply.value, 'compatibility');
    } finally {
      client?.close();
      server.forceShutdown();
    }
    console.log('PASS Firestore grpc/proto-loader unary client compatibility');

    // Exercise schema discovery and argument validation through the SDK, not
    // merely Zod in isolation: node-host registers raw Zod shapes this way.
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { z } = require('zod');
    const mcp = new McpServer({ name: 'compatibility', version: '1' });
    mcp.registerTool('bounded', {
      inputSchema: { limit: z.number().int().min(1).max(500).optional() },
    }, async ({ limit }) => ({ content: [{ type: 'text', text: String(limit ?? 50) }] }));
    const mcpClient = new Client({ name: 'compatibility-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport);
      await mcpClient.connect(clientTransport);
      const listed = await mcpClient.listTools();
      assert.equal(listed.tools[0].inputSchema.properties.limit.maximum, 500);
      const reply = await mcpClient.callTool({ name: 'bounded', arguments: { limit: 42 } });
      assert.equal(reply.content[0].text, '42');
      const rejected = await mcpClient.callTool({ name: 'bounded', arguments: { limit: 501 } });
      assert.equal(rejected.isError, true);
    } finally {
      await mcpClient.close();
      await mcp.close();
    }
    console.log('PASS MCP SDK/Zod schema discovery, invocation and bound rejection');

  } finally {
    clearTimeout(timeout);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
