// v4.32.472: рэтчет на дефект «лента не приходит по интернету».
//
// Интернет-ретранслятор намеренно не передаёт заголовок X-Sender (v4.32.216),
// поэтому приёмник вызывает receiveFeedEnvelope(payload, ''). Строгая ветка
// проверки спотыкалась о parseDidKey('') и роняла КАЖДЫЙ конверт ленты,
// пришедший по интернету, — при этом у отправителя запись уходила из очереди
// как доставленная. Тест держит одновременно два условия: пустой отправитель
// больше не роняет конверт, и подделка по-прежнему не проходит.
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn() },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));

import { readFileSync } from 'fs';
import { join } from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { receiveFeedEnvelope } from '../feedService';
import { isAuthorMuted } from '../mutedAuthors';
import {
  serializeFeedEnvelope,
  parseAndVerifyFeedEnvelope,
  parseAndVerifyRelayedFeedEnvelope,
  type FeedEnvelopePayload,
} from '../feedTransport';

const SRC = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

function newIdentity(): { pair: { secretKey: Uint8Array; publicKey: Uint8Array }; did: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { pair: { secretKey, publicKey }, did: publicKeyToDidKey(publicKey) };
}

function post(authorDid: string, postId = 'p1'): FeedEnvelopePayload {
  return {
    type: 'feed_post',
    postId,
    authorDid,
    // Возраст конверта проверяется отдельно: старше 7 суток отбраковывается
    // до подписи-проверки, поэтому здесь всегда «сейчас».
    ts: Date.now(),
    data: { kind: 'post', text: 'привет' },
  } as unknown as FeedEnvelopePayload;
}

async function frameFrom(
  signer: { secretKey: Uint8Array; publicKey: Uint8Array },
  payload: FeedEnvelopePayload,
): Promise<Uint8Array> {
  const frame = await serializeFeedEnvelope(signer, payload);
  if (!frame) throw new Error('serializeFeedEnvelope вернул null');
  return frame;
}

describe('проверка не пустая', () => {
  it('исходники читаются', () => {
    expect(read('core/social/feedService.ts').length).toBeGreaterThan(1000);
    expect(read('core/transport/internet/internetTransport.ts').length).toBeGreaterThan(1000);
  });

  it('конверт вообще собирается и проверяется своим же DID', async () => {
    const me = newIdentity();
    const frame = await frameFrom(me.pair, post(me.did));
    expect(await parseAndVerifyFeedEnvelope(frame, me.did)).toBeTruthy();
  });
});

describe('пустой отправитель у интернет-ретранслятора', () => {
  it('строгая ветка роняет конверт с пустым отправителем — это и был дефект', async () => {
    const me = newIdentity();
    const frame = await frameFrom(me.pair, post(me.did));
    expect(await parseAndVerifyFeedEnvelope(frame, '')).toBeNull();
  });

  it('ветка «автор из тела» принимает тот же самый конверт', async () => {
    const me = newIdentity();
    const frame = await frameFrom(me.pair, post(me.did));
    const payload = await parseAndVerifyRelayedFeedEnvelope(frame);
    expect(payload).toBeTruthy();
    expect(payload?.authorDid).toBe(me.did);
    expect(payload?.postId).toBe('p1');
  });

  it('приём по интернету выбирает ветку по пустому отправителю', () => {
    const src = read('core/social/feedService.ts');
    expect(src).toContain("const authorFromBody = relayed || senderDid === '';");
    expect(src).toContain('? await parseAndVerifyRelayedFeedEnvelope(innerFrame)');
    expect(src).toContain(': await parseAndVerifyFeedEnvelope(innerFrame, senderDid);');
  });

  it('транспорт по-прежнему не называет отправителя — иначе чинить было бы нечего', () => {
    const src = read('core/transport/internet/internetTransport.ts');
    expect(src).toContain('do NOT send X-Sender');
    expect(src).toContain("this.onFrame?.(senderDid, payload);");
    // Пустой отправитель — нормальный случай, а не повод бросить кадр.
    expect(src).toContain('if (senderDid) {');
  });

  it('приёмник интернет-кадров отдаёт отправителя ленте как есть', () => {
    const src = read('core/transport/internet/internetCoordinator.ts');
    expect(src).toContain('void receiveFeedEnvelope(payload, senderDid);');
  });
});

describe('подделку ветка «автор из тела» не пропускает', () => {
  it('чужая подпись под чужим именем отбраковывается', async () => {
    const me = newIdentity();
    const attacker = newIdentity();
    // Злоумышленник подписывает своим ключом, но называет автором жертву.
    const frame = await frameFrom(attacker.pair, post(me.did));
    expect(await parseAndVerifyRelayedFeedEnvelope(frame)).toBeNull();
  });

  it('подпись автора и его же имя — единственная принимаемая пара', async () => {
    const attacker = newIdentity();
    const frame = await frameFrom(attacker.pair, post(attacker.did));
    const payload = await parseAndVerifyRelayedFeedEnvelope(frame);
    expect(payload?.authorDid).toBe(attacker.did);
  });

  it('испорченное тело не проходит проверку подписи', async () => {
    const me = newIdentity();
    const frame = await frameFrom(me.pair, post(me.did));
    const text = new TextDecoder().decode(frame.slice(1));
    const outer = JSON.parse(text) as { payload: string; signature: string };
    outer.payload = outer.payload.replace('привет', 'пРивет');
    const bytes = new TextEncoder().encode(JSON.stringify(outer));
    const tampered = new Uint8Array(bytes.length + 1);
    tampered[0] = frame[0];
    tampered.set(bytes, 1);
    expect(await parseAndVerifyRelayedFeedEnvelope(tampered)).toBeNull();
  });

  it('конверт без authorDid в теле не проходит', async () => {
    const me = newIdentity();
    const noAuthor = { type: 'feed_post', postId: 'p1', ts: Date.now(), data: { kind: 'post', text: 'x' } };
    const frame = await frameFrom(me.pair, noAuthor as unknown as FeedEnvelopePayload);
    expect(await parseAndVerifyRelayedFeedEnvelope(frame)).toBeNull();
  });

  it('старый конверт отбраковывается обеими ветками', async () => {
    const me = newIdentity();
    const old = post(me.did);
    (old as { ts: number }).ts = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const frame = await frameFrom(me.pair, old);
    expect(await parseAndVerifyRelayedFeedEnvelope(frame)).toBeNull();
    expect(await parseAndVerifyFeedEnvelope(frame, me.did)).toBeNull();
  });
});

describe('в локальной сети сверка «автор == сосед» сохраняется', () => {
  it('названный сосед, не совпадающий с автором, отбраковывается', async () => {
    const me = newIdentity();
    const neighbour = newIdentity();
    const frame = await frameFrom(me.pair, post(me.did));
    expect(await parseAndVerifyFeedEnvelope(frame, neighbour.did)).toBeNull();
  });
});

// Поведенческая часть: приём конверта целиком, а не только разбор.
//
// Хранилище профиля в тесте не поднято, поэтому дальше проверки «не заглушён ли
// автор» приём всё равно упрётся в ensureStorage и запишет предупреждение —
// это ожидаемо и погашено внутри receiveFeedEnvelope. Нам важен сам факт: с
// пустым отправителем конверт ДОХОДИТ до обработки, а не отбраковывается на
// разборе, как было до исправления.
describe('приём конверта с пустым отправителем доходит до обработки', () => {
  const muted = isAuthorMuted as unknown as jest.Mock;

  beforeEach(() => {
    muted.mockClear();
  });

  it('пустой отправитель: конверт обрабатывается', async () => {
    const me = newIdentity();
    const frame = await frameFrom(me.pair, post(me.did, 'behav-empty'));
    await receiveFeedEnvelope(frame, '');
    expect(muted).toHaveBeenCalledWith(me.did);
  });

  it('названный отправитель, совпадающий с автором: конверт обрабатывается', async () => {
    const me = newIdentity();
    const frame = await frameFrom(me.pair, post(me.did, 'behav-named'));
    await receiveFeedEnvelope(frame, me.did);
    expect(muted).toHaveBeenCalledWith(me.did);
  });

  it('названный отправитель, не совпадающий с автором: конверт отбракован', async () => {
    const me = newIdentity();
    const neighbour = newIdentity();
    const frame = await frameFrom(me.pair, post(me.did, 'behav-mismatch'));
    await receiveFeedEnvelope(frame, neighbour.did);
    expect(muted).not.toHaveBeenCalled();
  });

  it('подделка с пустым отправителем: конверт отбракован', async () => {
    const me = newIdentity();
    const attacker = newIdentity();
    const frame = await frameFrom(attacker.pair, post(me.did, 'behav-forged'));
    await receiveFeedEnvelope(frame, '');
    expect(muted).not.toHaveBeenCalled();
  });
});
