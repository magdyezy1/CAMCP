import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport, getDefaultEnvironment} from '@modelcontextprotocol/client/stdio';
import {removeTestDirectory} from './temp.js';
test('standalone stdio process initializes, serves metadata and compiles a preview without credentials', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-stdio-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist/server/stdio.js')],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      MIRROR_DB: path.join(directory, 'test.sqlite'),
      MIRROR_TENANT_ID: 'stdio-test',
      MIRROR_MASTER_KEY: '',
      MIRROR_ALLOW_WRITES: 'false',
      MIRROR_MODE: 'strict',
      MIRROR_FLAGS: '{}',
    },
    stderr: 'pipe',
  });
  const client = new Client({name: 'stdio-integration', version: '1'});
  try {
    await client.connect(transport);
    // A read-only deployment lists amcp_write with inspect only (owner decision D15, MCP-09).
    // Parked providers are not offered by default: Amazon Ads (CON-06), Criteo and WooCommerce (ARC-01, P9).
    assert.equal((await client.listTools()).tools.length, 25);
    const result = await client.callTool({
      name: 'google_ads_native_action',
      arguments: {
        action: 'CREATE_CAMPAIGN',
        account_id: '111',
        payload: {
          resource: {
            name: 'Draft',
            advertising_channel_type: 'SEARCH',
            campaign_budget: 'customers/111/campaignBudgets/222',
          },
        },
        dry_run: true,
      },
    });
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data.success, true);
    assert.equal(data.data.executed, false);
    assert.equal(data.data.request.method, 'POST');
  } finally {
    await client.close();
    removeTestDirectory(directory, 'amcp-stdio-');
  }
});
test('stdio operator configuration exposes reviewed writes without granting account access', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-stdio-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist/server/stdio.js')],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      MIRROR_DB: path.join(directory, 'test.sqlite'),
      MIRROR_TENANT_ID: 'stdio-test',
      MIRROR_MASTER_KEY: Buffer.alloc(32, 44).toString('base64'),
      MIRROR_ALLOW_WRITES: 'true',
      MIRROR_ROLE: 'operator',
      MIRROR_MODE: 'strict',
      MIRROR_FLAGS: '{}',
    },
    stderr: 'pipe',
  });
  const client = new Client({name: 'stdio-write-integration', version: '1'});
  try {
    await client.connect(transport);
    // Parked providers are not offered by default: Amazon Ads (CON-06), Criteo and WooCommerce (ARC-01, P9).
    assert.equal((await client.listTools()).tools.length, 25);
    const result = await client.callTool({
      name: 'amcp_write',
      arguments: {
        action: 'prepare',
        gateway: 'meta_native_action',
        arguments: {
          action: 'meta_campaign_create',
          account_id: '123',
          payload: {name: 'Draft', status: 'PAUSED', is_adset_budget_sharing_enabled: false},
        },
      },
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse((result.content as any)[0].text).error.code, 'CONNECTION_REQUIRED');
  } finally {
    await client.close();
    removeTestDirectory(directory, 'amcp-stdio-');
  }
});
