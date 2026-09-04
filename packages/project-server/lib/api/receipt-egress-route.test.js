'use strict';

// HTTP contract for A1c.2: the server route forwards only expectedSha to the
// receipt egress authority and maps typed refusals without remote side effects.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { createRunReceiptRouter } = require('./run-receipt');
const { ReceiptEgressError } = require('../receipt-egress');

const SHA = 'a'.repeat(40);

test('A1c.2 route accepts exact SHA only and returns the authority result', async (t) => {
  const calls = [];
  const authority = { verify() {}, finalize() {}, store: { withLease: (_id, fn) => fn() } };
  const egress = {
    deliver(body) {
      calls.push(body);
      if (!body || Object.keys(body).join() !== 'expectedSha' || body.expectedSha !== SHA) {
        throw new ReceiptEgressError('EGRESS_BAD_REQUEST', 'exact expectedSha required');
      }
      return { outcome: 'delivered', candidateSha: SHA };
    },
  };
  const server = await mount(createRunReceiptRouter({}, {}, { authority, egress }));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const bad = await request(server.address().port, { expectedSha: SHA, repo: 'other/repo' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'EGRESS_BAD_REQUEST');
  const good = await request(server.address().port, { expectedSha: SHA });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, { outcome: 'delivered', candidateSha: SHA });
  assert.deepEqual(calls, [{ expectedSha: SHA, repo: 'other/repo' }, { expectedSha: SHA }]);
});

async function mount(router) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function request(port, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/workflow/egress/deliver', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
