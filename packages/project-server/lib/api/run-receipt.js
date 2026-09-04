'use strict';

/**
 * The narrow server-owned surface for the factory-run receipt.
 *
 *   POST /api/workflow/receipt/finalize   finalize the ACTIVE run's receipt
 *   GET  /api/workflow/receipt            the active run's receipt + drift check
 *   GET  /api/workflow/receipt/:runId     a specific run's receipt + drift check
 *   POST /api/workflow/egress/deliver     receipt-bound branch + PR delivery
 *
 * Finalization is classified as a mutation of the admitted run by the central
 * admission seam (server.js), so at the real server a legacy or unregistered
 * run is refused before this handler. The handler itself accepts exactly one
 * optional body field, `candidateSha`; it can make finalization refuse and
 * never make it succeed. Finalization itself performs no egress. The separate
 * delivery endpoint can push only the frozen candidate, create/reuse its exact
 * PR, and publish the receipt status; it has no merge or deletion capability.
 */

const express = require('express');
const { createRunReceiptAuthority, RunReceiptError, CODES } = require('../run-receipt');
const { createReceiptEgress, ReceiptEgressError } = require('../receipt-egress');
const { qaServerSuiteGateVerdict } = require('./workflow');

const ALLOWED_BODY = new Set(['candidateSha']);

function statusFor(code) {
  if (code === CODES.NO_ACTIVE_RUN || code === CODES.NOT_FOUND) return 404;
  if (code === CODES.BAD_REQUEST || code === 'EGRESS_BAD_REQUEST') return 400;
  return 409;
}

function refusal(res, error) {
  if (!(error instanceof RunReceiptError) && !(error instanceof ReceiptEgressError)) throw error;
  const { message, code, stack, name, ...details } = error;
  delete details.cause;
  return res.status(statusFor(code)).json({ code, error: message, egress: 'not_installed', ...details });
}

function createRunReceiptRouter(config, state, { qaGate = qaServerSuiteGateVerdict, authority, egress } = {}) {
  const router = express.Router();
  const receipts = authority || createRunReceiptAuthority({ config, state, qaGate });
  const delivery = egress || createReceiptEgress({ config, receiptAuthority: receipts });

  router.post('/workflow/receipt/finalize', (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const unknown = Object.keys(body).filter((key) => !ALLOWED_BODY.has(key));
    if (unknown.length > 0) {
      return res.status(400).json({
        code: CODES.BAD_REQUEST,
        error: `finalization accepts only candidateSha; refused fields: ${unknown.join(', ')}`,
        egress: 'not_installed',
      });
    }
    if (body.candidateSha !== undefined && typeof body.candidateSha !== 'string') {
      return res.status(400).json({ code: CODES.BAD_REQUEST, error: 'candidateSha must be a string', egress: 'not_installed' });
    }
    try {
      const result = receipts.finalize(body.candidateSha === undefined ? {} : { candidateSha: body.candidateSha });
      return res.status(200).json({ created: result.created, receipt: result.receipt, egress: 'not_installed' });
    } catch (error) {
      return refusal(res, error);
    }
  });

  function readHandler(runId) {
    return (req, res) => {
      try {
        const found = receipts.verify(runId === undefined ? undefined : req.params.runId);
        if (!found) {
          return res.status(404).json({ code: CODES.NOT_FOUND, error: 'no finalized receipt exists for this run', egress: 'not_installed' });
        }
        return res.json({ ...found, egress: 'not_installed' });
      } catch (error) {
        return refusal(res, error);
      }
    };
  }

  router.get('/workflow/receipt', readHandler(undefined));
  router.get('/workflow/receipt/:runId', readHandler('runId'));

  router.post('/workflow/egress/deliver', (req, res) => {
    try {
      return res.status(200).json(delivery.deliver(req.body));
    } catch (error) {
      return refusal(res, error);
    }
  });

  return router;
}

module.exports = { createRunReceiptRouter };
