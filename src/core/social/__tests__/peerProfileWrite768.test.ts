/**
 * Занятая база больше не замораживает профиль собеседника навсегда (v4.32.768).
 *
 * `setPeerProfileFor` отвечала «изменилось ли что-нибудь», и `false` значил
 * сразу пять разных вещей: строки контакта нет; строка не прочиталась (отказ
 * базы или запертый Keychain); конверт старее сохранённого; всё совпало и
 * писать нечего; запись не легла на диск. Четыре из пяти окончательны, пятая —
 * заминка на секунду.
 *
 * Разница видна снаружи. `handleIncomingPeerProfile` объявлял кадр разобранным
 * во всех пяти случаях: метка «докуда прочитано» у ретранслятора уходила
 * вперёд, а второго конверта не будет — отправителю его профиль «уже
 * доставлен». Имя, фото и «О себе» собеседника застывали до следующей его
 * правки, то есть могли не обновиться никогда.
 *
 * Ветка отсрочки там была с v4.32.759 — но зажигалась исключением, которого эта
 * запись не бросает: свой `catch` у неё внутри. Мёртвая ветка и проверка,
 * которая ей подыгрывала моком-бросателем, — вот и вся прежняя защита.
 *
 * Теперь исход назван словом, и откладывается ровно тот из пяти, что пройдёт со
 * второй попытки.
 */

/** Отказ записи: как `kvSetSecret`, когда шифрование или запись не состоялись. */
let mockWriteFails = false;
/** Строка контакта не прочиталась: отказ базы или ещё запертый Keychain. */
let mockRowUnreadable = false;

jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const kvGet = jest.fn(async (key: string) => kv[key] ?? null);
  const kvSet = jest.fn(async (key: string, value: string) => { kv[key] = value; });
  const kvDelete = jest.fn(async (key: string) => { delete kv[key]; });
  return {
    __kv: kv,
    kvGet,
    kvSet,
    kvDelete,
    kvTryGet: jest.fn(async (key: string) => ({ value: await kvGet(key) })),
    kvSetChecked: jest.fn(async (key: string, value: string) => {
      await kvSet(key, value);
      return true;
    }),
    kvDeleteChecked: jest.fn(async (key: string) => { await kvDelete(key); return true; }),
    kvListKeysByPrefix: jest.fn(async (prefix: string) =>
      Object.keys(kv).filter((k) => k.startsWith(prefix))),
    kvGetSecret: jest.fn(async (key: string) => kvGet(key)),
    kvGetSecretCell: jest.fn(async (key: string) => {
      // Непрочитанная строка контакта — третье состояние ячейки, не пустота.
      if (mockRowUnreadable && key.includes(':contact:')) return { state: 'unreadable' };
      const v = await kvGet(key);
      return v == null ? { state: 'absent' } : { state: 'plain', text: v };
    }),
    kvSetSecret: jest.fn(async (key: string, value: string) => {
      if (mockWriteFails) return false;
      await kvSet(key, value);
      return true;
    }),
    profileKvGet: jest.fn(async (profileId: number, key: string) => kvGet(`p${profileId}:${key}`)),
    profileKvSet: jest.fn(async (profileId: number, key: string, value: string) =>
      kvSet(`p${profileId}:${key}`, value)),
    profileKvDelete: jest.fn(async (profileId: number, key: string) =>
      kvDelete(`p${profileId}:${key}`)),
    kvDeleteScoped: jest.fn(async (profileId: number, key: string) =>
      kvDelete(`p${profileId}:${key}`)),
    contactNoteKey: jest.fn((b64: string) => `contact_note:${b64}`),
    recentlyDeletedKey: jest.fn((b64: string) => `recently_deleted:${b64}`),
    notifyChatStorageChanged: jest.fn(),
  };
});

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../../crypto/keyManager', () => {
  const { x25519 } = require('@noble/curves/ed25519.js');
  return {
    ecdhSharedSecret: jest.fn((mySecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array =>
      x25519.getSharedSecret(mySecretKey.slice(0, 32), peerPublicKey.slice(0, 32))),
    publicKeyHash4: jest.requireActual('../../crypto/keyManager').publicKeyHash4,
  };
});

import fs from 'fs';
import path from 'path';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  addContact,
  invalidateContactsList,
  setPeerProfileFor,
  setPeerProfileForChecked,
  type PeerProfilePatch,
} from '../contacts';
import type { KeyPairBytes } from '../../crypto/keyManager';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };
const kv = mockLocal.__kv;

function makeKeyPair(): KeyPairBytes {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey, secretKey } as unknown as KeyPairBytes;
}

const b64 = (peer: Uint8Array): string => Buffer.from(peer).toString('base64');
const rowKey = (peer: Uint8Array): string => `p1:contact:${b64(peer)}`;

/** Профиль «Маргарита» с названной отметкой версии. */
function patch(name: string, ts: number): PeerProfilePatch {
  return { name, bio: 'о себе', avatarCid: null, ts };
}

/** Завести контакт «Рита» и вернуть его открытый ключ в base64. */
async function withContact(): Promise<{ pub: Uint8Array; b64: string }> {
  const me = makeKeyPair();
  const peer = makeKeyPair();
  await addContact(me, peer.publicKey, 'Рита');
  return { pub: peer.publicKey, b64: b64(peer.publicKey) };
}

/** Только код: комментарии не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const read = (rel: string) => codeOnly(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  mockWriteFails = false;
  mockRowUnreadable = false;
  // Модульный TTL-кэш списка иначе переживает очистку kv.
  invalidateContactsList();
});

describe('пять исходов вместо одного «нет»', () => {
  it('запись не легла на диск — «не вышло»', async () => {
    const c = await withContact();
    const before = kv[rowKey(c.pub)];
    mockWriteFails = true;
    await expect(setPeerProfileForChecked(1, c.b64, patch('Маргарита', 100))).resolves.toBe(
      'failed'
    );
    expect(kv[rowKey(c.pub)]).toBe(before);
  });

  it('строка контакта не прочиталась — тоже «не вышло», а не «контакта нет»', async () => {
    const c = await withContact();
    mockRowUnreadable = true;
    await expect(setPeerProfileForChecked(1, c.b64, patch('Маргарита', 100))).resolves.toBe(
      'failed'
    );
    // И поверх нечитаемого шифртекста ничего не записано.
    expect(kv[rowKey(c.pub)]).toContain('Рита');
  });

  it('контакта нет — «контакта нет»: повтор кадра его не заведёт', async () => {
    const stranger = makeKeyPair();
    await expect(
      setPeerProfileForChecked(1, b64(stranger.publicKey), patch('Маргарита', 100))
    ).resolves.toBe('no-contact');
  });

  it('конверт старее сохранённого — «устарел»', async () => {
    const c = await withContact();
    await setPeerProfileForChecked(1, c.b64, patch('Маргарита', 200));
    await expect(setPeerProfileForChecked(1, c.b64, patch('Рита', 100))).resolves.toBe('stale');
    expect(kv[rowKey(c.pub)]).toContain('Маргарита');
  });

  it('всё и так совпало — «без изменений», и это не отказ', async () => {
    const c = await withContact();
    await setPeerProfileForChecked(1, c.b64, patch('Маргарита', 100));
    await expect(setPeerProfileForChecked(1, c.b64, patch('Маргарита', 200))).resolves.toBe(
      'unchanged'
    );
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: обычное применение — «применено»', async () => {
    const c = await withContact();
    await expect(setPeerProfileForChecked(1, c.b64, patch('Маргарита', 100))).resolves.toBe(
      'applied'
    );
    expect(kv[rowKey(c.pub)]).toContain('Маргарита');
  });

  it('пять разных исходов и вправду различимы', async () => {
    const outcomes: string[] = [];
    const c = await withContact();
    outcomes.push(await setPeerProfileForChecked(1, c.b64, patch('Маргарита', 200)));
    outcomes.push(await setPeerProfileForChecked(1, c.b64, patch('Маргарита', 300)));
    outcomes.push(await setPeerProfileForChecked(1, c.b64, patch('Рита', 100)));
    const stranger = makeKeyPair();
    outcomes.push(await setPeerProfileForChecked(1, b64(stranger.publicKey), patch('Кто', 100)));
    mockWriteFails = true;
    outcomes.push(await setPeerProfileForChecked(1, c.b64, patch('Марго', 400)));
    expect(outcomes).toEqual(['applied', 'unchanged', 'stale', 'no-contact', 'failed']);
  });
});

describe('сплющивающая форма осталась — и осталась обёрткой', () => {
  it('«изменилось» отвечает true только на применение', async () => {
    const c = await withContact();
    await expect(setPeerProfileFor(1, c.b64, patch('Маргарита', 100))).resolves.toBe(true);
    // Совпавшее не «изменилось»: экранам перерисовываться незачем.
    await expect(setPeerProfileFor(1, c.b64, patch('Маргарита', 200))).resolves.toBe(false);
    mockWriteFails = true;
    await expect(setPeerProfileFor(1, c.b64, patch('Марго', 300))).resolves.toBe(false);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('различающая форма отвечает словом, а сплющивающая — ровно обёртка', () => {
    const contacts = read('contacts.ts');
    expect(contacts).toContain('export type PeerProfileWrite =');
    expect(contacts).toContain(
      "return (await setPeerProfileForChecked(pid, peerPublicKeyB64, profile)) === 'applied';"
    );
    // Своей записи у обёртки быть не должно: две копии разъедутся.
    const a = contacts.indexOf('export async function setPeerProfileFor(');
    const b = contacts.indexOf('export async function setPeerProfileForChecked(');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(contacts.slice(a, b)).not.toContain('contactRowSet(');
  });

  it('строка контакта читается различающей формой: «нет» и «не прочлась» — разное', () => {
    const contacts = read('contacts.ts');
    const at = contacts.indexOf('export async function setPeerProfileForChecked(');
    const body = contacts.slice(at, at + 1200);
    expect(body).toContain('const cell = await contactRowCell(pid, peerPublicKeyB64);');
    expect(body).toContain("if (cell.state === 'unreadable') {");
    expect(body).not.toContain('await contactRowGet(');
  });

  it('приёмник откладывает ровно отказ, а не что попало', () => {
    const sync = read('profileSync.ts');
    expect(sync).toContain(
      'const applied = await setPeerProfileForChecked(ownerPid, senderPubB64, { ...env, verified });'
    );
    expect(sync).toContain("if (applied === 'failed') {");
    // Прежняя ветка ждала исключения, которого эта запись не бросает.
    expect(sync).not.toContain('await setPeerProfileFor(ownerPid, senderPubB64,');
    const at = sync.indexOf("if (applied === 'failed') {");
    expect(sync.slice(at, at + 200)).toContain("return 'deferred';");
  });
});
