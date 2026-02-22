#!/usr/bin/env node
const path = require('path');

let ToolClient;
try {
  require('ts-node').register({
    project: path.join(__dirname, '../../agent_runtime/tsconfig.json'),
    transpileOnly: true,
  });
  ({ ToolClient } = require('../../agent_runtime/src/tools/toolClient'));
} catch (_e) {
  ({ ToolClient } = require('../../agent_runtime/dist/tools/toolClient'));
}

async function run() {
  const gatewayBaseUrl = process.env.GATEWAY_BASE_URL || 'http://localhost:8080';
  const client = new ToolClient({ gatewayBaseUrl, timeoutMs: 5000, logPayload: true });

  const memorySearch = await client.call({
    tool: 'memory.search',
    input: {
      data: {
        user_id: 'u001',
        query_tags: ['ramen'],
        city: 'tokyo',
        top_k: 3,
      },
    },
  });
  console.log('\n[memory.search] ok=', memorySearch.ok, 'status=', memorySearch.error?.code || 200);
  console.log('[memory.search] keys=', Object.keys(memorySearch.output || {}));

  const tesBuild = await client.call({
    tool: 'embedding.tes_build',
    input: {
      tags: ['ramen', 'izakaya'],
      recency_days: 3,
      normalize: true,
    },
  });
  console.log('\n[embedding.tes_build] ok=', tesBuild.ok, 'status=', tesBuild.error?.code || 200);
  if (tesBuild.ok && tesBuild.output) {
    console.log('[embedding.tes_build] dim=', tesBuild.output.dim, 'normalized=', tesBuild.output.normalized);
  } else {
    console.log('[embedding.tes_build] error=', tesBuild.error);
  }

  const memoryRead = await client.call({
    tool: 'memory.read',
    input: {
      memory_id: 'non_exist_memory_id_for_smoke',
    },
  });
  console.log('\n[memory.read] ok=', memoryRead.ok, 'gateway_error=', memoryRead.error?.message || 'none');
  console.log('[memory.read] output=', memoryRead.output || null);

  const pass = memorySearch.ok && tesBuild.ok;
  if (!pass) {
    process.exitCode = 1;
    console.error('\nagent_toolclient_gateway_smoke: FAIL');
    return;
  }
  console.log('\nagent_toolclient_gateway_smoke: PASS');
}

run().catch((e) => {
  console.error('agent_toolclient_gateway_smoke: FAIL', e);
  process.exit(1);
});
