'use strict';

const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const {
  MAX_PEER_ID_LENGTH,
  isPlainObject,
  hasExactKeys,
  isBoundedString,
  isPeerId,
  isSignature,
  verifyEd25519,
} = require('./wire');
const { createPushRoutes } = require('./push');

const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_ROOM_ID_LENGTH = 256;
const MAX_SDP_LENGTH = 64 * 1024;
const MAX_CANDIDATE_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 10 * 1000;
const RATE_LIMIT = 120;
const MAX_CONNECTIONS = 256;
const MAX_CONNECTIONS_PER_IP = 16;
const REGISTRATION_TIMEOUT_MS = 15 * 1000;
const REGISTRATION_CHALLENGE_BYTES = 32;
/**
 * Журнал непринятых звонков (v4.32.558).
 *
 * Повтор предложения (см. callService, OFFER_RETRY_INTERVAL_MS) спасает только
 * того, кто успел появиться в сети за 45 секунд звонка. Кто не успел — не
 * узнавал о звонке вообще ничего: сокета не было, push на iOS нет, а сервер
 * ничего не помнил. Теперь несостоявшийся звонок остаётся здесь и уезжает
 * получателю первым же событием после регистрации.
 *
 * Что здесь лежит: пара идентификаторов и время. Сервер и так видит обе
 * стороны, когда передаёт им предложение, — новым знанием это его не делает,
 * но знание перестало быть мгновенным, и потому у него есть срок. Ни sdp, ни
 * адресов устройства тут нет и быть не должно.
 */
const MISSED_CALL_TTL_MS = 24 * 60 * 60 * 1000;
/** Сколько разных звонивших помним одному получателю. */
const MISSED_CALLS_PER_PEER = 20;
/** Скольким получателям сразу. Выше — вытесняем тех, чья запись старше всех. */
const MISSED_CALL_PEERS = 10_000;

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
  const message = Buffer.from(`${challenge}\n${roomId}\n${peerId}`, 'utf8');
  return verifyEd25519(peerId, message, signature);
}

/**
 * Единственное место, где события push попадают в лог. Одна строка JSON на
 * событие: так их видно и глазами, и через `fly logs | grep push_`. Без этого
 * доставка была немой — понять, лёг ли реестр токенов на том или остался
 * в памяти, было нельзя ничем, кроме ssh на машину.
 *
 * В самих событиях нет ни токенов, ни идентификаторов собеседников: только
 * платформа, счётчик и исход отправки.
 */
function logEvent(event, fields) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event, ...fields }));
}

function createSignalingServer(options = {}) {
  const configuredPort = options.port ?? process.env.PORT;
  const port = configuredPort === undefined ? 3001 : Number(configuredPort);
  const rateWindowMs = options.rateWindowMs ?? RATE_WINDOW_MS;
  const rateLimit = options.rateLimit ?? RATE_LIMIT;
  const maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP;
  const registrationTimeoutMs = options.registrationTimeoutMs ?? REGISTRATION_TIMEOUT_MS;
  const push = options.push
    ?? createPushRoutes({ env: options.env, log: options.log ?? logEvent });
  const httpServer = http.createServer((request, response) => {
    if (push.handle(request, response)) return;
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
  /** targetPeerId -> Map(fromPeerId -> { at, attempts }) */
  const missedCalls = new Map();
  const missedCallTtlMs = options.missedCallTtlMs ?? MISSED_CALL_TTL_MS;

  function newestMissedAt(byCaller) {
    let newest = 0;
    for (const entry of byCaller.values()) if (entry.at > newest) newest = entry.at;
    return newest;
  }

  function rememberMissedCall(targetPeerId, fromPeerId, now = Date.now()) {
    let byCaller = missedCalls.get(targetPeerId);
    if (!byCaller) {
      byCaller = new Map();
      missedCalls.set(targetPeerId, byCaller);
    }
    const existing = byCaller.get(fromPeerId);
    // Повторы одного и того же звонка идут каждые 3 секунды. Записью считаем
    // звонок, а не попытку: иначе один неотвеченный звонок вытеснил бы из
    // журнала все предыдущие.
    if (existing) {
      existing.at = now;
      existing.attempts += 1;
    } else {
      byCaller.set(fromPeerId, { at: now, attempts: 1 });
    }
    while (byCaller.size > MISSED_CALLS_PER_PEER) {
      byCaller.delete(byCaller.keys().next().value);
    }
    if (missedCalls.size > MISSED_CALL_PEERS) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, value] of missedCalls) {
        const at = newestMissedAt(value);
        if (at < oldestAt) { oldestAt = at; oldestKey = key; }
      }
      if (oldestKey !== null) missedCalls.delete(oldestKey);
    }
  }

  /**
   * Дозвонились — записи быть не должно. Иначе человек, взявший трубку,
   * увидел бы при следующем входе «вам звонили» о разговоре, который у него
   * только что состоялся.
   */
  function forgetMissedCall(targetPeerId, fromPeerId) {
    const byCaller = missedCalls.get(targetPeerId);
    if (!byCaller) return;
    byCaller.delete(fromPeerId);
    if (byCaller.size === 0) missedCalls.delete(targetPeerId);
  }

  function takeMissedCalls(peerId, now = Date.now()) {
    const byCaller = missedCalls.get(peerId);
    if (!byCaller) return [];
    missedCalls.delete(peerId);
    const calls = [];
    for (const [fromPeerId, entry] of byCaller) {
      if (now - entry.at > missedCallTtlMs) continue;
      calls.push({ fromPeerId, at: entry.at, attempts: entry.attempts });
    }
    calls.sort((a, b) => a.at - b.at);
    return calls;
  }


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
        // Первым делом после регистрации — то, что человек пропустил, пока
        // его не было. Отправляем и уносим: журнал живёт до доставки.
        const missed = takeMissedCalls(value.peerId);
        if (missed.length > 0) socket.emit('missed_calls', { calls: missed });
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
          rememberMissedCall(value.targetPeerId, registration.peerId);
          sendUnavailable(socket, value.targetPeerId, value.roomId);
          return;
        }
        forgetMissedCall(value.targetPeerId, registration.peerId);
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
    push,
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
    MISSED_CALL_TTL_MS,
    MISSED_CALLS_PER_PEER,
    MISSED_CALL_PEERS,
  },
};
