'use strict';

const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_ROOM_ID_LENGTH = 256;
const MAX_PEER_ID_LENGTH = 256;
const MAX_SDP_LENGTH = 64 * 1024;
const MAX_CANDIDATE_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 10 * 1000;
const RATE_LIMIT = 120;
const MAX_CONNECTIONS = 256;
const MAX_CONNECTIONS_PER_IP = 16;
const REGISTRATION_TIMEOUT_MS = 15 * 1000;
const REGISTRATION_CHALLENGE_BYTES = 32;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function isBoundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCanonicalBase64(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    && value.length % 4 === 0
    && Buffer.from(value, 'base64').toString('base64') === value;
}

function isPeerId(value) {
  if (!isBoundedString(value, MAX_PEER_ID_LENGTH) || !isCanonicalBase64(value)) return false;
  return Buffer.from(value, 'base64').length === ED25519_PUBLIC_KEY_BYTES;
}

function isSignature(value) {
  if (!isCanonicalBase64(value)) return false;
  return Buffer.from(value, 'base64').length === ED25519_SIGNATURE_BYTES;
}

function validRegister(payload) {
  return hasExactKeys(payload, ['peerId', 'roomId', 'signature'])
    && isBoundedString(payload.roomId, MAX_ROOM_ID_LENGTH)
    && isPeerId(payload.peerId)
    && isSignature(payload.signature);
}

function validOffer(payload) {
  return hasExactKeys(payload, ['roomId', 'sdp', 'targetPeerId'])
    && isBoundedString(payload.roomId, MAX_ROOM_ID_LENGTH)
    && isPeerId(payload.targetPeerId)
    && typeof payload.sdp === 'string'
    && payload.sdp.length > 0
    && payload.sdp.length <= MAX_SDP_LENGTH;
}

function validDescription(payload) {
  return hasExactKeys(payload, ['sdp', 'targetPeerId'])
    && isPeerId(payload.targetPeerId)
    && typeof payload.sdp === 'string'
    && payload.sdp.length > 0
    && payload.sdp.length <= MAX_SDP_LENGTH;
}

function validIceCandidate(payload) {
  if (!hasExactKeys(payload, ['candidate', 'targetPeerId'])
    || !isPeerId(payload.targetPeerId)
    || !isPlainObject(payload.candidate)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(payload.candidate), 'utf8') <= MAX_CANDIDATE_BYTES;
  } catch {
    return false;
  }
}

function validHangup(payload) {
  return hasExactKeys(payload, ['targetPeerId'])
    && isPeerId(payload.targetPeerId);
}

function verifyRegistration(peerId, roomId, signature, challenge) {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(peerId, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    const message = Buffer.from(`${challenge}\n${roomId}\n${peerId}`, 'utf8');
    return crypto.verify(null, message, publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

function createSignalingServer(options = {}) {
  const configuredPort = options.port ?? process.env.PORT;
  const port = configuredPort === undefined ? 3001 : Number(configuredPort);
  const rateWindowMs = options.rateWindowMs ?? RATE_WINDOW_MS;
  const rateLimit = options.rateLimit ?? RATE_LIMIT;
  const maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP;
  const registrationTimeoutMs = options.registrationTimeoutMs ?? REGISTRATION_TIMEOUT_MS;
  const httpServer = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, service: 'airchat-signaling-example' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  const io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN || '*' },
    maxHttpBufferSize: options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES,
  });
  const peers = new Map();
  const connectionsByIp = new Map();

  function remoteAddress(socket) {
    return socket.handshake.address || socket.conn.remoteAddress || 'unknown';
  }

  function rejectConnection(socket, error) {
    socket.emit('signaling_error', { event: 'connection', error });
    socket.disconnect(true);
  }

  io.use((socket, next) => {
    const address = remoteAddress(socket);
    const currentForIp = connectionsByIp.get(address) || 0;
    if (io.sockets.sockets.size >= maxConnections) {
      next(new Error('connection_limit'));
      return;
    }
    if (currentForIp >= maxConnectionsPerIp) {
      next(new Error('connection_limit_per_ip'));
      return;
    }
    socket.data.remoteAddress = address;
    next();
  });

  function sendError(socket, event, error) {
    socket.emit('signaling_error', { event, error });
  }

  function peerFor(targetPeerId) {
    const peer = peers.get(targetPeerId);
    return peer && peer.socket.connected ? peer : null;
  }

  function sendUnavailable(socket, targetPeerId, roomId) {
    socket.emit('peer_unavailable', { targetPeerId, roomId });
  }

  function route(socket, event, payload, validator, callback, requiresRegistration = true, ack) {
    const registration = socket.data.registration;
    const bucket = socket.data.rateBucket;
    const now = Date.now();
    if (now - bucket.startedAt >= rateWindowMs) {
      bucket.startedAt = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    if (bucket.count > rateLimit) {
      sendError(socket, event, 'rate_limited');
      if (typeof ack === 'function') ack({ ok: false, error: 'rate_limited' });
      return;
    }
    if (requiresRegistration && !registration) {
      sendError(socket, event, 'not_registered');
      if (typeof ack === 'function') ack({ ok: false, error: 'not_registered' });
      return;
    }
    if (!validator(payload)) {
      sendError(socket, event, 'invalid_payload');
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_payload' });
      return;
    }
    callback(registration, payload);
  }

  io.on('connection', (socket) => {
    const address = socket.data.remoteAddress || remoteAddress(socket);
    connectionsByIp.set(address, (connectionsByIp.get(address) || 0) + 1);
    socket.data.rateBucket = { startedAt: Date.now(), count: 0 };
    socket.data.registrationChallenge = crypto.randomBytes(REGISTRATION_CHALLENGE_BYTES).toString('base64url');
    socket.data.registrationTimer = setTimeout(() => {
      if (!socket.data.registration) rejectConnection(socket, 'registration_timeout');
    }, registrationTimeoutMs);
    socket.emit('registration_challenge', { challenge: socket.data.registrationChallenge });

    socket.on('register', (payload, ack) => {
      route(socket, 'register', payload, validRegister, (_oldRegistration, value) => {
        if (!verifyRegistration(value.peerId, value.roomId, value.signature, socket.data.registrationChallenge)) {
          sendError(socket, 'register', 'invalid_proof');
          if (typeof ack === 'function') ack({ ok: false, error: 'invalid_proof' });
          return;
        }
        const existing = peers.get(value.peerId);
        if (existing && existing.socket !== socket) {
          sendError(socket, 'register', 'peer_in_use');
          if (typeof ack === 'function') ack({ ok: false, error: 'peer_in_use' });
          return;
        }
        const previous = socket.data.registration;
        if (previous && peers.get(previous.peerId)?.socket === socket) peers.delete(previous.peerId);
        const registration = { roomId: value.roomId, peerId: value.peerId, socket };
        socket.data.registration = registration;
        socket.data.registrationChallenge = null;
        clearTimeout(socket.data.registrationTimer);
        socket.data.registrationTimer = null;
        peers.set(value.peerId, registration);
        socket.emit('registered', { roomId: value.roomId, peerId: value.peerId });
        if (typeof ack === 'function') ack({ ok: true, roomId: value.roomId, peerId: value.peerId });
      }, false, ack);
    });

    socket.on('offer', (payload) => {
      route(socket, 'offer', payload, validOffer, (registration, value) => {
        if (value.roomId !== registration.roomId) {
          sendError(socket, 'offer', 'room_mismatch');
          return;
        }
        const target = peerFor(value.targetPeerId);
        if (!target || target.socket === socket) {
          sendUnavailable(socket, value.targetPeerId, value.roomId);
          return;
        }
        target.socket.emit('offer', { roomId: value.roomId, fromPeerId: registration.peerId, sdp: value.sdp });
      });
    });

    socket.on('answer', (payload) => {
      route(socket, 'answer', payload, validDescription, (registration, value) => {
        const target = peerFor(value.targetPeerId);
        if (!target || target.socket === socket) {
          sendUnavailable(socket, value.targetPeerId, registration.roomId);
          return;
        }
        target.socket.emit('answer', { fromPeerId: registration.peerId, sdp: value.sdp });
      });
    });

    socket.on('ice-candidate', (payload) => {
      route(socket, 'ice-candidate', payload, validIceCandidate, (registration, value) => {
        const target = peerFor(value.targetPeerId);
        if (!target || target.socket === socket) {
          sendUnavailable(socket, value.targetPeerId, registration.roomId);
          return;
        }
        target.socket.emit('ice-candidate', { fromPeerId: registration.peerId, candidate: value.candidate });
      });
    });

    socket.on('hangup', (payload) => {
      route(socket, 'hangup', payload, validHangup, (registration, value) => {
        const target = peerFor(value.targetPeerId);
        if (!target || target.socket === socket) {
          sendUnavailable(socket, value.targetPeerId, registration.roomId);
          return;
        }
        target.socket.emit('hangup', { fromPeerId: registration.peerId });
      });
    });

    socket.on('disconnect', () => {
      clearTimeout(socket.data.registrationTimer);
      const remainingForIp = (connectionsByIp.get(address) || 1) - 1;
      if (remainingForIp > 0) connectionsByIp.set(address, remainingForIp);
      else connectionsByIp.delete(address);
      const registration = socket.data.registration;
      if (!registration || peers.get(registration.peerId)?.socket !== socket) return;
      peers.delete(registration.peerId);
      // Each AirChat peer registers in its own room (roomId=peerId), so a
      // same-room broadcast never reaches the active caller/callee. The peer
      // id is already public and clients filter this notification against
      // their current call, so notify all remaining peers instead.
      for (const peer of peers.values()) {
        peer.socket.emit('peer_unavailable', {
          targetPeerId: registration.peerId,
          roomId: registration.roomId,
        });
      }
    });
  });

  return {
    httpServer,
    io,
    peers,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve(httpServer.address().port);
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        io.close((ioError) => {
          if (ioError) {
            reject(ioError);
            return;
          }
          if (!httpServer.listening) {
            resolve();
            return;
          }
          httpServer.close((httpError) => (httpError ? reject(httpError) : resolve()));
        });
      });
    },
  };
}

if (require.main === module) {
  const server = createSignalingServer();
  server.listen().then((actualPort) => {
    // eslint-disable-next-line no-console
    console.log(`AirChat signaling server listening on ${actualPort}`);
  }).catch((error) => {
    // eslint-disable-next-line no-console
    console.error('AirChat signaling server failed to start', error);
    process.exitCode = 1;
  });
}

module.exports = {
  createSignalingServer,
  constants: {
    MAX_PAYLOAD_BYTES,
    MAX_ROOM_ID_LENGTH,
    MAX_PEER_ID_LENGTH,
    MAX_SDP_LENGTH,
    MAX_CANDIDATE_BYTES,
    RATE_WINDOW_MS,
    RATE_LIMIT,
    MAX_CONNECTIONS,
    MAX_CONNECTIONS_PER_IP,
    REGISTRATION_TIMEOUT_MS,
  },
};
