/**
 * Несостоявшаяся запись строки контакта не выдаётся за удавшуюся (v4.32.660).
 *
 * `kvSetSecret` отвечает булевым: легло на диск или нет. `contactRowSet` этот
 * ответ выбрасывал, и все четыре вызывающих распоряжались отказом как успехом:
 * `addContact` ставил ключ в `contacts_index` без самой строки и отвечал «готово»,
 * `ensureImplicitContact` писал в журнал `implicit_contact_created`,
 * `setPeerProfileFor` отвечал «профиль обновился» по одному различию присланного
 * и сохранённого, `renameContact` возвращался молча — и экран показывал
 * «Имя обновлено» поверх старого имени.
 */

let mockWriteFails = false;

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
      const v = await kvGet(key);
      return v == null ? { state: 'absent' } : { state: 'plain', text: v };
    }),
    // Настоящий kvSetSecret отвечает false, когда шифрование или запись не
    // состоялись, и молчит об этом только в журнале. Ровно этот случай и
    // включает mockWriteFails.
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
  CONTACT_ROW_WRITE_FAILED_MESSAGE,
  ensureImplicitContact,
  invalidateContactsList,
  renameContact,
  setPeerProfileFor,
} from '../contacts';
import type { KeyPairBytes } from '../../crypto/keyManager';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };
const kv = mockLocal.__kv;

const INDEX_KEY = 'p1:contacts_index';

function makeKeyPair(): KeyPairBytes {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey, secretKey } as unknown as KeyPairBytes;
}

function rowKey(peer: Uint8Array): string {
  return `p1:contact:${Buffer.from(peer).toString('base64')}`;
}

function indexNow(): string[] {
  const raw = kv[INDEX_KEY];
  return raw === undefined ? [] : (JSON.parse(raw) as string[]);
}

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  mockWriteFails = false;
  // Модульный TTL-кэш списка иначе переживает очистку kv.
  invalidateContactsList();
});

describe('строка контакта: отказ записи не выдаётся за успех', () => {
  test('addContact при отказе записи отказывается и не пишет ключ в указатель', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    mockWriteFails = true;
    await expect(addContact(me, peer.publicKey, 'Рита')).rejects.toThrow(
      CONTACT_ROW_WRITE_FAILED_MESSAGE
    );
    expect(kv[rowKey(peer.publicKey)]).toBeUndefined();
    expect(indexNow()).toEqual([]);
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: при исправной записи addContact заводит контакт', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Рита');
    expect(kv[rowKey(peer.publicKey)]).toBeDefined();
    expect(indexNow()).toEqual([Buffer.from(peer.publicKey).toString('base64')]);
  });

  test('ensureImplicitContact при отказе записи отвечает false и не трогает указатель', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    mockWriteFails = true;
    await expect(ensureImplicitContact(1, me, peer.publicKey, 'Рита')).resolves.toBe(false);
    expect(kv[rowKey(peer.publicKey)]).toBeUndefined();
    expect(indexNow()).toEqual([]);
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: при исправной записи ensureImplicitContact отвечает true', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await expect(ensureImplicitContact(1, me, peer.publicKey, 'Рита')).resolves.toBe(true);
    expect(kv[rowKey(peer.publicKey)]).toBeDefined();
    expect(indexNow()).toEqual([Buffer.from(peer.publicKey).toString('base64')]);
  });

  test('setPeerProfileFor при отказе записи отвечает false, а не «изменилось»', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Рита');
    const b64 = Buffer.from(peer.publicKey).toString('base64');
    const before = kv[rowKey(peer.publicKey)];
    mockWriteFails = true;
    await expect(
      setPeerProfileFor(1, b64, { name: 'Маргарита', bio: 'о себе', avatarCid: null, ts: 100 })
    ).resolves.toBe(false);
    expect(kv[rowKey(peer.publicKey)]).toBe(before);
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: при исправной записи setPeerProfileFor отвечает true', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Рита');
    const b64 = Buffer.from(peer.publicKey).toString('base64');
    await expect(
      setPeerProfileFor(1, b64, { name: 'Маргарита', bio: 'о себе', avatarCid: null, ts: 100 })
    ).resolves.toBe(true);
    expect(kv[rowKey(peer.publicKey)]).toContain('Маргарита');
  });

  test('renameContact при отказе записи отказывается, а не молчит', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Рита');
    const b64 = Buffer.from(peer.publicKey).toString('base64');
    mockWriteFails = true;
    await expect(renameContact(b64, 'Маргарита')).rejects.toThrow(
      CONTACT_ROW_WRITE_FAILED_MESSAGE
    );
    expect(kv[rowKey(peer.publicKey)]).toContain('Рита');
    expect(kv[rowKey(peer.publicKey)]).not.toContain('Маргарита');
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: при исправной записи renameContact меняет имя молча', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Рита');
    const b64 = Buffer.from(peer.publicKey).toString('base64');
    await expect(renameContact(b64, 'Маргарита')).resolves.toBeUndefined();
    expect(kv[rowKey(peer.publicKey)]).toContain('Маргарита');
  });

  test('ПОВОД ДЛЯ ПРАВКИ ЖИВ: kvSetSecret по-прежнему отвечает булевым, а contactRowSet его отдаёт', () => {
    const local = fs.readFileSync(path.join(__dirname, '../../storage/local.ts'), 'utf8');
    expect(local).toContain(
      'export async function kvSetSecret(key: string, value: string): Promise<boolean> {'
    );
    const contacts = fs.readFileSync(path.join(__dirname, '../contacts.ts'), 'utf8');
    expect(contacts).toContain(
      'async function contactRowSet(pid: number, peerPubB64: string, json: string): Promise<boolean> {'
    );
    expect(contacts).toContain(
      '  return await kvSetSecret(profileScopedKey(pid, `${PREFIX}${peerPubB64}`), json);'
    );
    // Все четыре вызывающих смотрят на ответ: ни одного голого `await contactRowSet(`.
    expect(contacts.split('const stored = await contactRowSet(').length - 1).toBe(4);
    expect(contacts).not.toContain('    await contactRowSet(');
  });
});
