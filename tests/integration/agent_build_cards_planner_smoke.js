#!/usr/bin/env node
/**
 * Real integration smoke: direct HTTP call to gateway planner.compose.
 *
 * Usage:
 *   node tests/integration/agent_build_cards_planner_smoke.js
 *
 * Env:
 *   GATEWAY_BASE_URL (default http://localhost:8080)
 *   PLANNER_TOOL_URL  (default ${GATEWAY_BASE_URL}/tool/planner.compose)
 */

const http = require('http');
const https = require('https');

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(payload);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch (_e) {
            // keep null
          }
          resolve({ status: res.statusCode || 0, body: json, raw });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  const gatewayBase = process.env.GATEWAY_BASE_URL || 'http://localhost:8080';
  const plannerToolUrl =
    process.env.PLANNER_TOOL_URL || `${gatewayBase.replace(/\/$/, '')}/tool/planner.compose`;

  const payload = {
    data: {
      user_id: 'u001',
      city: 'tokyo',
      tags: ['ramen', 'walk'],
      cz_ranked: [
        {
          id: 'tokyo_cz_001',
          city: 'tokyo',
          title: 'Shinjuku Ramen Alley',
          tags: ['ramen'],
          score_CZ: 0.91,
          components: {
            tag_similarity: 0.8,
            memory_influence: 1.1,
            location_relevance: 1.0,
          },
        },
      ],
      ez_ranked: [
        {
          id: 'tokyo_ez_001',
          city: 'tokyo',
          title: 'Kiyosumi Garden Walk',
          tags: ['walk', 'park'],
          score_EZ: 0.74,
          components: {
            global_excellence: 0.82,
            taste_similarity_raw: 0.45,
            taste_similarity_capped: 0.45,
            taste_distance: 0.55,
          },
        },
      ],
      mix_policy: { ratio: '2:1', rule: 'balanced' },
      intent: { city: 'tokyo', type: 'food', tags: ['ramen', 'walk'] },
      decision_trace: {
        mix_policy: {
          rule_id: 'mix_policy_v1',
          ratio: { label: '2:1', cz: 2, ez: 1 },
        },
      },
    },
  };

  const result = await postJson(plannerToolUrl, payload);

  console.log(`[planner.compose] status=${result.status}`);
  if (!result.body || typeof result.body !== 'object') {
    console.error('[planner.compose] invalid JSON response');
    console.error(result.raw);
    process.exit(1);
  }

  const body = result.body;
  const hasPlannerField =
    Array.isArray(body.cards) || typeof body.detail === 'string' || body.service === 'planner';

  if (result.status !== 200) {
    console.error('[planner.compose] expected HTTP 200');
    console.error(JSON.stringify(body));
    process.exit(1);
  }
  if (!hasPlannerField) {
    console.error('[planner.compose] response missing planner fields (cards/detail/service)');
    console.error(JSON.stringify(body));
    process.exit(1);
  }

  console.log(
    `[planner.compose] ok=${body.ok} service=${body.service || 'n/a'} cards_count=${Array.isArray(body.cards) ? body.cards.length : 0}`
  );
  if (body.trace_id) {
    console.log(`[planner.compose] trace_id=${body.trace_id}`);
  }
  if (typeof body.detail === 'string') {
    console.log(`[planner.compose] detail=${body.detail}`);
  }

  console.log('agent_build_cards_planner_smoke: PASS');
}

run().catch((error) => {
  console.error('agent_build_cards_planner_smoke: FAIL');
  console.error(error?.message || error);
  process.exit(1);
});
