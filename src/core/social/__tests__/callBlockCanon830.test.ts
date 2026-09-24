/**
 * Заблокированный дозванивался, записав свой ключ иначе (v4.32.830).
 *
 * Дефект. Кто звонит — приложение узнаёт из строки, которую отдаёт сигнальный
 * сервер, и эта строка шла в блок-лист как есть. А записей у одного ключа
 * несколько: тридцать два байта в base64 — это `…I1c=` с выравниванием и
 * `…I1c` без него, плюс url-safe, где `+` и `/` заменены на `-` и `_`. Все
 * четыре расшифровываются в один и тот же ключ, и все четыре проходят проверку
 * формы — она для того и написана широкой, url-safe приходит из ссылок. Но
 * блок-лист хранит канон, а сверяется строкой: `Set.has('…I1c')` про запрет на
 * `…I1c=` не знает ничего.
 *
 * Подпись конверта здесь не сторож: она считается по ключу, вынутому из той же
 * строки, а «подписал тот, кем представился» сверяет строку саму с собой.
 * Звонящий подписывает своим настоящим ключом — просто представляется им в
 * другой записи.
 *
 * Цена. «Заблокировать» в приложении означает «этот человек со мной не
 * связывается»: сообщения не доходят, «печатает» не показывается, звонок не
 * звонит. Обходится это одним символом: заблокированный звонит, телефон звонит
 * на весь дом, а в журнале остаётся «вам звонили» от того, кого запретили. Ни
 * в журнале приложения, ни на экране обход не виден — входящий выглядит
 * обычным.
 *
 * Правка. Строка с провода приводится к канону (canonPubKeyB64) прежде, чем её
 * сверят с запретом, положат в журнал звонков или подставят в конверт. Проверка
 * формы осталась широкой — сузить её нельзя, url-safe записи настоящие.
 */
type MissedCall = { fromPeerId: string; at: number; attempts: number; e?: string };

const mockKvGetSecret = jest.fn(async (_key: string): Promise<string | null> => null);
const mockKvSetSecret = jest.fn(async (_key: string, _value: string): Promise<boolean> => true);
const mockKvDelete = jest.fn(async (_key: string): Promise<void> => undefined);

jest.mock('../../storage/local', () => ({
  kvGetSecret: (key: string) => mockKvGetSecret(key),
  kvSetSecret: (key: string, value: string) => mockKvSetSecret(key, value),
  kvDelete: (key: string) => mockKvDelete(key),
}));

jest.mock('../../../notifications/pushNotifications', () => ({
  notifyMissedCall: jest.fn(async () => undefined),
}));

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: class { close = jest.fn(); },
  RTCSessionDescription: class { constructor(value: unknown) { void value; } },
  RTCIceCandidate: class { constructor(value: unknown) { void value; } },
  mediaDevices: { getUserMedia: jest.fn() },
}));

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    connect = jest.fn(async () => undefined);
    register = jest.fn();
    disconnect = jest.fn();
    sendHangup = jest.fn();
    sendOffer = jest.fn();
    sendAnswer = jest.fn();
    sendIceCandidate = jest.fn();
    onOffer = jest.fn();
    onAnswer = jest.fn();
    onIceCandidate = jest.fn();
    onHangup = jest.fn();
    onPeerUnavailable = jest.fn();
    onMissedCalls = jest.fn();
  },
}));

jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => ({ webrtc: { signalingUrl: 'http://signal.test' } })),
}));

/** Блок-лист: хранит ровно то, что дала карточка контакта, — канон. */
const mockBlocked = new Set<string>();
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async (): Promise<void> => undefined,
    isBlocked: (key: string): boolean => mockBlocked.has(key),
  },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import fs from 'fs';
import path from 'path';

import { canonPubKeyB64, isPubKeyB64, publicKeyToB64 } from '../../crypto/pubKeyFormat';
import { sealCallEnvelope } from '../callEnvelope';
import { disposeCallService, getCallLog, initCallService, recordMissedCalls } from '../callService';
import { makePeer, testCallId } from './callTestPeers';

const PID = 4;
const me = makePeer();
const peer = makePeer();

/** Та же самая запись без выравнивания: у ключа в 32 байта хвост `=` всегда. */
const unpadded = (pub: string): string => pub.replace(/=+$/, '');

/**
 * Придержанный сервером звонок, где звонящий представился названной записью
 * ключа. Расписка подписана настоящим ключом — подделывать её незачем.
 */
async function held(from: string, at = Date.now() - 60_000): Promise<MissedCall> {
  const e = await sealCallEnvelope(peer.pair, from, {
    kind: 'missed',
    to: me.pub,
    callId: testCallId(),
    now: at,
  });
  return { fromPeerId: from, at, attempts: 3, e };
}

beforeEach(async () => {
  mockBlocked.clear();
  mockKvGetSecret.mockClear();
  mockKvSetSecret.mockClear();
  mockKvSetSecret.mockImplementation(async () => true);
  await disposeCallService();
  await initCallService(me.pair, PID);
});

afterEach(async () => {
  await disposeCallService();
});

describe('запрет держит человека, а не запись его ключа', () => {
  it('ключ без выравнивания — тот же запрет, звонка в журнале нет', async () => {
    mockBlocked.add(peer.pub);
    const res = await recordMissedCalls([await held(unpadded(peer.pub))], me.pub);
    expect(res.added).toBe(0);
    expect(getCallLog()).toEqual([]);
  });

  it('запись сама по себе настоящая: без запрета тот же звонок доходит', async () => {
    const res = await recordMissedCalls([await held(unpadded(peer.pub))], me.pub);
    expect(res.added).toBe(1);
  });

  it('в журнал ложится канон, а не то, чем звонящий представился', async () => {
    // Иначе один человек раздваивается: карточка контакта, история звонков и
    // переписка расходятся по разным записям одного ключа.
    await recordMissedCalls([await held(unpadded(peer.pub))], me.pub);
    expect(getCallLog().map((e) => e.peerPubB64)).toEqual([peer.pub]);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Канон — это приведение, а не ужесточение: он не вправе отсеять звонок,
 * который раньше доходил, и не вправе пропустить то, что раньше отвергалось.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный звонок доходит, негодный — нет', () => {
  it('канонический ключ незаблокированного — звонок в журнале', async () => {
    const res = await recordMissedCalls([await held(peer.pub)], me.pub);
    expect(res.added).toBe(1);
    expect(getCallLog().map((e) => e.peerPubB64)).toEqual([peer.pub]);
  });

  it('канонический ключ заблокированного — по-прежнему ничего', async () => {
    mockBlocked.add(peer.pub);
    expect((await recordMissedCalls([await held(peer.pub)], me.pub)).added).toBe(0);
  });

  it.each([
    ['короткая строка', 'AAAA'],
    ['не строка вовсе', 12345 as unknown as string],
    ['буквы не из алфавита', 'Ы'.repeat(44)],
  ])('%s — звонка нет', async (_name, from) => {
    expect((await recordMissedCalls([{ fromPeerId: from, at: Date.now(), attempts: 1 }], me.pub)).added).toBe(0);
  });

  it('расписка чужим ключом не проходит и с каноном', async () => {
    const other = makePeer();
    const e = await sealCallEnvelope(other.pair, peer.pub, {
      kind: 'missed',
      to: me.pub,
      callId: testCallId(),
      now: Date.now() - 60_000,
    });
    const res = await recordMissedCalls(
      [{ fromPeerId: peer.pub, at: Date.now() - 60_000, attempts: 1, e }],
      me.pub
    );
    expect(res.added).toBe(0);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Проверку формы сузить нельзя: url-safe запись ключа — настоящая, она приходит
 * из ссылок, и отвергать её значило бы ломать переход по приглашению. Значит
 * одной проверкой формы вопрос «тот ли это человек» не закрывается никогда, и
 * приведение к канону остаётся обязательным.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: у ключа записей больше одной', () => {
  /** Ключ, чья каноническая запись заведомо содержит и `+`, и `/`. */
  const RAW = new Uint8Array(32).fill(0xfb);
  const CANON = publicKeyToB64(RAW);
  const FORMS = [
    CANON,
    CANON.replace(/=+$/, ''),
    CANON.replace(/\+/g, '-').replace(/\//g, '_'),
    CANON.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  ];

  it('записи действительно разные, и их четыре', () => {
    expect(CANON).toContain('+');
    expect(CANON).toContain('/');
    expect(new Set(FORMS).size).toBe(4);
  });

  it.each(FORMS)('проверка формы принимает запись %s', (form) => {
    expect(isPubKeyB64(form)).toBe(true);
  });

  it.each(FORMS)('и все четыре — один и тот же человек: %s', (form) => {
    expect(canonPubKeyB64(form)).toBe(CANON);
  });

  it('негодное канон не выдумывает', () => {
    expect(canonPubKeyB64('AAAA')).toBeNull();
    expect(canonPubKeyB64(null)).toBeNull();
    expect(canonPubKeyB64('Ы'.repeat(44))).toBeNull();
  });
});

/** Рэтчет формы: строка с провода не попадает в запрет напрямую. */
describe('форма исходников: сверяется канон', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'callService.ts'), 'utf8');
  const CODE = SRC.split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('обе двери с провода приводят ключ к канону', () => {
    expect(CODE).toContain('const fromPeerId = canonPubKeyB64(call.fromPeerId);');
    expect(CODE).toContain('const fromPubB64 = canonPubKeyB64(msg.fromPeerId);');
  });

  it('запрет не спрашивают про строку сервера', () => {
    expect(CODE).not.toContain('isBlocked(call.fromPeerId)');
    expect(CODE).not.toContain('isBlocked(msg.fromPeerId)');
  });

  it('свой ли это разговор — тоже вопрос про ключ, а не про запись', () => {
    expect(CODE).toContain('return !!peer && canonPubKeyB64(fromPeerId) === peer;');
  });

  it('конверт сверяет ключи, а не строки, и отдаёт наружу канон', () => {
    // Иначе правка была бы наполовину: запрет обошёл бы канон, зато расписка
    // от человека, записавшего свой ключ иначе, перестала бы приниматься —
    // «тот же» ключ не сошёлся бы сам с собой.
    const ENV = fs.readFileSync(path.join(__dirname, '..', 'callEnvelope.ts'), 'utf8');
    expect(ENV).toContain('if (canonPubKeyB64(body.from) !== fromCanon) return null;');
    expect(ENV).toContain('if (canonPubKeyB64(body.to) !== toCanon) return null;');
    expect(ENV).not.toContain('if (body.from !== expect.from) return null;');
    expect(ENV).not.toContain('from: body.from as string');
  });
});
