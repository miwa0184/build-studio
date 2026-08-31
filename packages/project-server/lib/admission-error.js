'use strict';

/**
 * Admission failures are a deliberately small error family. Keep this
 * predicate narrow: an ordinary TypeError or programmer exception must retain
 * its normal 500 semantics instead of being laundered into a policy refusal.
 */
function isAdmissionError(err) {
  return Boolean(err && (
    err.name === 'AdmissionRefusedError'
    || err.code === 'ADMISSION_BACKSTOP'
    || err.code === 'RUN_GUARD_MISSING'
  ));
}

function admissionErrorPayload(err) {
  return {
    code: (err && err.code) || 'ADMISSION_REFUSED',
    error: (err && err.message) || 'admission failed',
    admission: 'refused',
  };
}

/**
 * The smallest common Express error boundary, mounted after every server and
 * API route. Router-local authority handlers may still handle their own richer
 * errors, but anything that crosses a router boundary gets the same stable
 * machine-readable admission refusal here.
 */
function createAdmissionErrorHandler() {
  return function admissionErrorHandler(err, req, res, next) {
    if (!isAdmissionError(err)) return next(err);
    return res.status(403).json(admissionErrorPayload(err));
  };
}

module.exports = { isAdmissionError, admissionErrorPayload, createAdmissionErrorHandler };
