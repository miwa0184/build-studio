'use strict';

// HTTP contract for A1c.2: the server route forwards only expectedSha to the
// receipt egress authority and maps typed refusals without remote side effects.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { createRunReceiptRouter } = require('./run-receipt');
const { ReceiptEgressError } = require('../receipt-egress');
const { RunReceiptError } = require('../run-receipt');

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
  assert.equal(bad.body.egress, 'receipt_pr_delivery');
  const good = await request(server.address().port, { expectedSha: SHA });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, { outcome: 'delivered', candidateSha: SHA });
  assert.deepEqual(calls, [{ expectedSha: SHA, repo: 'other/repo' }, { expectedSha: SHA }]);
});

test('A1c.2 route reports the installed capability for receipt-authority refusals', async (t) => {
  const authority = { verify() {}, finalize() {}, store: { withLease: (_id, fn) => fn() } };
  const egress = {
    deliver() {
      throw new RunReceiptError('RECEIPT_EVIDENCE_DRIFT', 'receipt changed');
    },
  };
  const server = await mount(createRunReceiptRouter({}, {}, { authority, egress }));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await request(server.address().port, { expectedSha: SHA });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'RECEIPT_EVIDENCE_DRIFT');
  assert.equal(response.body.egress, 'receipt_pr_delivery');
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
