const express = require('express');

const VAULT = /^\/v1\/cloud-vault\/[^/]+$/;
const PUSH = /^\/v1\/sync\/[^/]+\/push$/;
const MEDIA = /^\/v1\/sync\/[^/]+\/media\/put$/;
const POST = /^\/v1\/post\/[^/]+(?:\/delete)?$/;

function bodyLimitFor(req, limits) {
  if (req.method === 'PUT' && VAULT.test(req.path)) return limits.vaultBytes;
  if (req.method === 'POST') {
    if (PUSH.test(req.path)) return limits.syncPushBytes;
    if (MEDIA.test(req.path)) return limits.mediaBytes;
    if (POST.test(req.path)) return limits.publicPostBytes;
  }
  return limits.defaultBytes;
}

/** Keep large decoded bodies admitted until their response completes. */
function createBodyParser(limits, { maxInflight = 1 } = {}) {
  let inflight = 0;
  const parsers = new Map();
  return (req, res, next) => {
    const limit = bodyLimitFor(req, limits);
    const large = limit > limits.defaultBytes;
    if (large && inflight >= maxInflight) {
      res.set('retry-after', '5');
      return res.status(503).json({ error: 'server_busy' });
    }
    let released = false;
    const release = () => {
      if (!large || released) return;
      released = true;
      inflight -= 1;
      res.removeListener('finish', release);
      res.removeListener('close', release);
    };
    if (large) {
      inflight += 1;
      res.once('finish', release);
      res.once('close', release);
    }
    if (!parsers.has(limit)) parsers.set(limit, express.json({ limit }));
    try {
      return parsers.get(limit)(req, res, (error) => {
        if (error) release();
        next(error);
      });
    } catch (error) {
      release();
      return next(error);
    }
  };
}

module.exports = { bodyLimitFor, createBodyParser };
