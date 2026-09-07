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
  trustProxyEnabled,
  clientAddressFrom,
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
 *
 * v4.32.615: к записи прилагается расписка звонившего. Сам список сервер
 * сочинял единолично, а клиент верил ему на слово — значит мог вписать звонки,
 * которых не было, и вытеснить ими настоящие: журнал у клиента держит сто
 * последних. Расписку выдаёт звонящий, когда узнаёт, что не дозвонился; сервер
 * её только хранит и отдаёт вместе с записью. Внутри всё та же пара
 * идентификаторов и время, но под подписью — содержимого в ней по-прежнему
 * нет. Расписка кладётся только к уже существующей записи: сочинить нового
 * получателя ею нельзя, память от неё не растёт.
 */
const MISSED_CALL_TTL_MS = 24 * 60 * 60 * 1000;
/** Расписка — короткий подписанный JSON; предел с большим запасом. */
const MAX_MISSED_RECEIPT_LENGTH = 4 * 1024;
/** Сколько разных звонивших помним одному получателю. */
const MISSED_CALLS_PER_PEER = 20;
/** Скольким получателям сразу. Выше — вытесняем тех, чья запись старше всех. */
const MISSED_CALL_PEERS = 10_000;
/**
 * Общий предел журнала (v4.32.617).
 *
 * Пределы выше считают каждый своё: двадцать звонивших одному получателю,
 * десять тысяч получателей. Перемножаются они плохо — двести тысяч записей, и
 * к каждой расписка до четырёх килобайт, то есть под гигабайт на машине, у
 * которой всей памяти 256 МБ. Сами пределы менять не надо: они про смысл, а не
 * про память. Поэтому рядом стоят два общих — на число записей и на объём
 * расписок; при переполнении вытесняется запись того получателя, к чьему
 * журналу дольше всех не обращались.
 */
const MISSED_CALL_ENTRIES = 20_000;
/**
 * Сколько ждать расписки о получении журнала (v4.32.617).
 *
 * Журнал удалялся до отправки: сокет, оборвавшийся в эту же секунду, уносил
 * пропущенные звонки навсегда — человек о них не узнавал никогда, потому что
 * заново их никто не создаст. Теперь удаление ждёт подтверждения от клиента.
 * Старые сборки его не шлют, и ждать их вечно нельзя: по истечении срока
 * журнал убирается, если сокет всё ещё на связи (значит, доехало), и
 * остаётся, если связь оборвалась.
 */
const MISSED_DELIVERY_ACK_MS = 10 * 1000;
const MISSED_CALL_RECEIPT_BYTES = 4 * 1024 * 1024;
/**
 * Скольких собеседников помним одному подключению (v4.32.581).
 *
 * Нужно только для того, чтобы сказать «собеседник ушёл» тем, кого это
 * касается. Разговоров за одно подключение бывает немного, а верхняя граница
 * тут для того, чтобы память не росла от того, кто шлёт предложения подряд.
 */
const SIGNALING_COUNTERPARTS_PER_PEER = 64;

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

function validMissedReceipt(payload) {
  return hasExactKeys(payload, ['e', 'targetPeerId'])
    && isPeerId(payload.targetPeerId)
    && isBoundedString(payload.e, MAX_MISSED_RECEIPT_LENGTH)
    && payload.e.length > 0;
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
  /**
   * Заголовки CORS для обычных HTTP-маршрутов (v4.32.563).
   *
   * У socket.io своя настройка (ниже), и до этой версии только она и была:
   * `/webpush-key` и `/register-token` отвечали без единого
   * Access-Control-заголовка. Из приложения на телефоне это незаметно — там
   * нет источника и нет проверки. А веб-версия живёт на другом домене, и
   * браузер молча отбрасывал ответ: подписаться на push со страницы было
   * нельзя вообще, притом без ошибки на сервере.
   *
   * Политика та же, что у сокета, — CORS_ORIGIN или «любой»: ключ здесь
   * открытый по назначению, а регистрация токена и так подписана.
   */
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  const corsHeaders = {
    'access-control-allow-origin': corsOrigin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
  };
  const httpServer = http.createServer((request, response) => {
    for (const [k, v] of Object.entries(corsHeaders)) response.setHeader(k, v);
    // Предполётный запрос браузер шлёт перед POST с JSON. Отвечать на него
    // должен сам сервер: до маршрутов он не доходит.
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
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
  /** targetPeerId -> Map(fromPeerId -> { at, attempts, e }) */
  const missedCalls = new Map();
  const missedCallTtlMs = options.missedCallTtlMs ?? MISSED_CALL_TTL_MS;
  const missedCallPeers = options.missedCallPeers ?? MISSED_CALL_PEERS;
  const missedCallEntriesMax = options.missedCallEntries ?? MISSED_CALL_ENTRIES;
  const missedDeliveryAckMs = options.missedDeliveryAckMs ?? MISSED_DELIVERY_ACK_MS;
  const missedCallReceiptBytesMax = options.missedCallReceiptBytes ?? MISSED_CALL_RECEIPT_BYTES;
  let missedCallEntries = 0;
  let missedCallReceiptBytes = 0;
  const trustProxy = options.trustProxy ?? trustProxyEnabled(options.env ?? process.env);

  /**
   * Порядок вставки в Map — он же порядок давности (v4.32.615).
   *
   * Раньше при переполнении сервер обходил все десять тысяч получателей и у
   * каждого — до двадцати звонивших, чтобы выбросить ровно одну запись. Тот,
   * кто держит журнал полным, платил за это чужим процессорным временем на
   * каждом своём предложении. Теперь тронутая запись переставляется в конец, и
   * выбрасывается первая — это делается за постоянное время и вытесняет ровно
   * того, к кому дольше всех не обращались.
   */
  function touchNewest(map, key, value) {
    map.delete(key);
    map.set(key, value);
  }

  /** Единственное место, где запись исчезает поштучно: счётчики держатся тут. */
  function dropMissedCall(byCaller, targetPeerId, fromPeerId) {
    const entry = byCaller.get(fromPeerId);
    if (!entry) return;
    byCaller.delete(fromPeerId);
    missedCallEntries -= 1;
    if (entry.e) missedCallReceiptBytes -= entry.e.length;
    if (byCaller.size === 0) missedCalls.delete(targetPeerId);
  }

  /** То же для целого получателя. */
  function dropMissedTarget(targetPeerId) {
    const byCaller = missedCalls.get(targetPeerId);
    if (!byCaller) return;
    for (const entry of byCaller.values()) {
      missedCallEntries -= 1;
      if (entry.e) missedCallReceiptBytes -= entry.e.length;
    }
    missedCalls.delete(targetPeerId);
  }

  /**
   * Срок записи проверялся только при выдаче — а выдача бывает, если человек
   * вернулся. Кто не вернулся, тот занимал память сутки и дольше. Обход идёт с
   * головы: порядок вставки здесь — порядок последнего обращения, и на первом
   * же непросроченном получателе можно остановиться.
   */
  function sweepMissedCalls(now) {
    for (const [targetPeerId, byCaller] of missedCalls) {
      let newest = 0;
      for (const entry of byCaller.values()) if (entry.at > newest) newest = entry.at;
      if (now - newest <= missedCallTtlMs) break;
      dropMissedTarget(targetPeerId);
    }
  }

  /** Вытеснить самую давнюю запись самого давнего получателя. */
  function evictOldestMissedCall() {
    const targetPeerId = missedCalls.keys().next().value;
    if (targetPeerId === undefined) return false;
    const byCaller = missedCalls.get(targetPeerId);
    const fromPeerId = byCaller.keys().next().value;
    if (fromPeerId === undefined) {
      missedCalls.delete(targetPeerId);
      return true;
    }
    dropMissedCall(byCaller, targetPeerId, fromPeerId);
    return true;
  }

  function enforceMissedCallBudget() {
    while (missedCallEntries > missedCallEntriesMax || missedCallReceiptBytes > missedCallReceiptBytesMax) {
      if (!evictOldestMissedCall()) break;
    }
  }

  function rememberMissedCall(targetPeerId, fromPeerId, now = Date.now()) {
    sweepMissedCalls(now);
    let byCaller = missedCalls.get(targetPeerId);
    if (!byCaller) byCaller = new Map();
    touchNewest(missedCalls, targetPeerId, byCaller);
    const existing = byCaller.get(fromPeerId);
    // Повторы одного и того же звонка идут каждые 3 секунды. Записью считаем
    // звонок, а не попытку: иначе один неотвеченный звонок вытеснил бы из
    // журнала все предыдущие.
    if (existing) {
      existing.at = now;
      existing.attempts += 1;
      touchNewest(byCaller, fromPeerId, existing);
    } else {
      byCaller.set(fromPeerId, { at: now, attempts: 1, e: null });
      missedCallEntries += 1;
    }
    while (byCaller.size > MISSED_CALLS_PER_PEER) {
      dropMissedCall(byCaller, targetPeerId, byCaller.keys().next().value);
    }
    while (missedCalls.size > missedCallPeers) {
      dropMissedTarget(missedCalls.keys().next().value);
    }
    enforceMissedCallBudget();
  }

  /**
   * Расписка ложится только к записи, которая уже есть: она подтверждает
   * звонок, а не создаёт его. Своей записи звонящий этим не заводит, чужую не
   * трогает — ключ здесь его собственный peerId, проверенный при регистрации.
   */
  function attachMissedReceipt(targetPeerId, fromPeerId, e) {
    const byCaller = missedCalls.get(targetPeerId);
    if (!byCaller) return false;
    const entry = byCaller.get(fromPeerId);
    if (!entry) return false;
    missedCallReceiptBytes += e.length - (entry.e ? entry.e.length : 0);
    entry.e = e;
    enforceMissedCallBudget();
    return true;
  }

  /**
   * Дозвонились — записи быть не должно. Иначе человек, взявший трубку,
   * увидел бы при следующем входе «вам звонили» о разговоре, который у него
   * только что состоялся.
   */
  function forgetMissedCall(targetPeerId, fromPeerId) {
    const byCaller = missedCalls.get(targetPeerId);
    if (!byCaller) return;
    dropMissedCall(byCaller, targetPeerId, fromPeerId);
  }

  /** Прочитать журнал, ничего не удаляя: удаление ждёт расписки о получении. */
  function readMissedCalls(peerId, now = Date.now()) {
    const byCaller = missedCalls.get(peerId);
    if (!byCaller) return [];
    const calls = [];
    for (const [fromPeerId, entry] of byCaller) {
      if (now - entry.at > missedCallTtlMs) continue;
      calls.push({
        fromPeerId,
        at: entry.at,
        attempts: entry.attempts,
        ...(entry.e ? { e: entry.e } : {}),
      });
    }
    calls.sort((a, b) => a.at - b.at);
    return calls;
  }


  /**
   * Кому сообщать об уходе (v4.32.581).
   *
   * Раньше `peer_unavailable` при разрыве уходил всем подключённым сразу.
   * Задумано это было как замена комнатной рассылки: в AirChat каждый
   * регистрируется в комнате со своим же именем (roomId = peerId), и рассылка
   * по комнате не доходит ни до кого. Но платой оказалась чужая тайна:
   * peerId — это открытый ключ человека, и любой, кто просто держал сокет
   * открытым, читал по этим событиям, кто из всех пользователей сейчас в сети
   * и когда ушёл. Для мессенджера, который прячет даже содержимое, это слишком
   * много.
   *
   * Теперь помним, с кем подключение обменивалось сигналами, и говорим об
   * уходе только им — и по-прежнему всей комнате, если комната настоящая, то
   * есть названа не своим же именем.
   */
  function rememberCounterpart(registration, peerId) {
    if (!registration || registration.peerId === peerId) return;
    const known = registration.counterparts;
    known.delete(peerId);
    known.add(peerId);
    while (known.size > SIGNALING_COUNTERPARTS_PER_PEER) {
      known.delete(known.keys().next().value);
    }
  }

  function linkCounterparts(registration, target) {
    rememberCounterpart(registration, target.peerId);
    rememberCounterpart(target, registration.peerId);
  }

  function departureAudience(registration) {
    const audience = new Set();
    for (const peerId of registration.counterparts) {
      const peer = peers.get(peerId);
      if (peer && peer.socket.connected) audience.add(peer);
    }
    // Общая комната остаётся общей: там уход участника — общая новость.
    if (registration.roomId !== registration.peerId) {
      for (const peer of peers.values()) {
        if (peer.roomId === registration.roomId) audience.add(peer);
      }
    }
    return audience;
  }

  function remoteAddress(socket) {
    return clientAddressFrom(
      socket.handshake.headers,
      socket.handshake.address || socket.conn.remoteAddress,
      trustProxy
    );
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
        const registration = { roomId: value.roomId, peerId: value.peerId, socket, counterparts: new Set() };
        socket.data.registration = registration;
        // v4.32.617: задача не обнуляется, а меняется. Обнулённую проверяли
        // как строку «null» — второй `register` по тому же сокету подписывал
        // заранее известный текст, и подписью годилась любая старая. Заодно
        // чинится смена профиля на живом сокете: раньше она перерегистрацию
        // не проходила никогда.
        socket.data.registrationChallenge = crypto
          .randomBytes(REGISTRATION_CHALLENGE_BYTES)
          .toString('base64url');
        socket.emit('registration_challenge', { challenge: socket.data.registrationChallenge });
        clearTimeout(socket.data.registrationTimer);
        socket.data.registrationTimer = null;
        peers.set(value.peerId, registration);
        socket.emit('registered', { roomId: value.roomId, peerId: value.peerId });
        if (typeof ack === 'function') ack({ ok: true, roomId: value.roomId, peerId: value.peerId });
        // Первым делом после регистрации — то, что человек пропустил, пока
        // его не было. Журнал живёт до подтверждённой доставки.
        const missed = readMissedCalls(value.peerId);
        if (missed.length > 0) {
          const forPeerId = value.peerId;
          socket.timeout(missedDeliveryAckMs).emit('missed_calls', { calls: missed }, (error) => {
            // Ошибка здесь — истёкшее ожидание. Если сокет на связи, значит
            // журнал доехал, а расписки не шлёт старая сборка: убираем. Если
            // связь оборвалась — журнал остаётся до следующего входа.
            if (error && !socket.connected) return;
            dropMissedTarget(forPeerId);
          });
        }
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
        linkCounterparts(registration, target);
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
        linkCounterparts(registration, target);
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
        linkCounterparts(registration, target);
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
        linkCounterparts(registration, target);
        target.socket.emit('hangup', { fromPeerId: registration.peerId });
      });
    });

    socket.on('missed_receipt', (payload) => {
      route(socket, 'missed_receipt', payload, validMissedReceipt, (registration, value) => {
        attachMissedReceipt(value.targetPeerId, registration.peerId, value.e);
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
      // Только тем, кого это касается: см. departureAudience.
      for (const peer of departureAudience(registration)) {
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
