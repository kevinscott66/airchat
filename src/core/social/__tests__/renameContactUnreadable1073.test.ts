/**
 * Непрочитанная строка контакта перестала выдаваться за переименованную
 * (v4.32.1073).
 *
 * ДЕФЕКТ. `renameContact` читал строку через `contactRowGet`, а тот сводит к
 * одному `null` и «строки нет», и «строку не прочитали»: внутри —
 * `cellTextOrNull`, и он обе беды даёт одинаково. На `null` обработчик молча
 * возвращался, и после него шли `notifyChatStorageChanged()` и
 * `emitContactsChanged()` — то есть наружу это выглядело как удачное
 * переименование. Экран карточки на это отвечал «Имя обновлено».
 *
 * Разбор тремя состояниями рядом есть и заведён ровно под это:
 * `contactRowCell` (v4.32.641). `addContact` его спрашивает с тех же пор;
 * `renameContact` — нет. Отказ самой ЗАПИСИ здесь починили в v4.32.660, отказ
 * ЧТЕНИЯ остался.
 *
 * ЦЕНА. Хранилище не отвечает в первые секунды после перезагрузки телефона,
 * пока Keychain заперт. Человек переименовывает контакт, видит зелёное «Имя
 * обновлено», новое имя встаёт в карточке и через `onRenamed` уезжает в шапку
 * переписки — а на диске не изменилось ничего, и после перезапуска имя
 * прежнее. Переименовывают обычно затем, чтобы различить двоих одинаковых,
 * так что потерянная правка значит «написал не тому».
 *
 * ПРАВКА. Тот же `mayOverwrite`, что у `addContact`, и тот же текст отказа.
 * Собрать строку заново поверх непрочитанного шифртекста нельзя и по второй
 * причине: в ней лежит профиль собеседника целиком (v4.32.570).
 *
 * ГРАНИЦЫ. Отсутствие строки остаётся тихим: переименовывать нечего, и оба
 * экрана зовут это только для контакта, взятого из указателя.
 */

let mockWriteFails = false;
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
    kvSetChecked: jest.fn(async (key: string, value: string) => { await kvSet(key, value); return true; }),
    kvDeleteChecked: jest.fn(async (key: string) => { await kvDelete(key); return true; }),
    kvListKeysByPrefix: jest.fn(async (prefix: string) =>
      Object.keys(kv).filter((k) => k.startsWith(prefix))),
    kvGetSecret: jest.fn(async (key: string) => kvGet(key)),
    // Непрочитанный шифртекст: столбец на месте, расшифровать нечем. Ровно
    // то, что даёт запертый Keychain.
    kvGetSecretCell: jest.fn(async (key: string) => {
      const v = await kvGet(key);
      if (v == null) return { state: 'absent' };
      if (mockRowUnreadable && key.includes(':contact:')) return { state: 'unreadable' };
      return { state: 'plain', text: v };
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
  CONTACT_ROW_UNREADABLE_MESSAGE,
  CONTACT_ROW_WRITE_FAILED_MESSAGE,
  invalidateContactsList,
  renameContact,
} from '../contacts';
import type { KeyPairBytes } from '../../crypto/keyManager';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };
const kv = mockLocal.__kv;

function makeKeyPair(): KeyPairBytes {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey, secretKey } as unknown as KeyPairBytes;
}
const rowKey = (peer: Uint8Array): string => `p1:contact:${Buffer.from(peer).toString('base64')}`;
const b64 = (peer: Uint8Array): string => Buffer.from(peer).toString('base64');
const nameIn = (peer: Uint8Array): string =>
  (JSON.parse(kv[rowKey(peer)]) as { displayName?: string }).displayName ?? '';

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  mockWriteFails = false;
  mockRowUnreadable = false;
  invalidateContactsList();
});

describe('переименование отличает непрочитанную строку от отсутствующей', () => {
  test('непрочитанная строка — отказ вслух, а не молчаливый успех', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Рита');
    mockRowUnreadable = true;
    await expect(renameContact(b64(peer.publicKey), 'Маргарита')).rejects.toThrow(
      CONTACT_ROW_UNREADABLE_MESSAGE
    );
    // И поверх непрочитанного шифртекста ничего не легло: в строке лежит
    // профиль собеседника целиком, собирать её заново нельзя.
    mockRowUnreadable = false;
    expect(nameIn(peer.publicKey)).toBe('Рита');
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: читаемая строка по-прежнему переименовывается', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Рита');
    await expect(renameContact(b64(peer.publicKey), 'Маргарита')).resolves.toBeUndefined();
    expect(nameIn(peer.publicKey)).toBe('Маргарита');
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: отказ записи по-прежнему свой, с прежним текстом', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Рита');
    mockWriteFails = true;
    await expect(renameContact(b64(peer.publicKey), 'Маргарита')).rejects.toThrow(
      CONTACT_ROW_WRITE_FAILED_MESSAGE
    );
    expect(CONTACT_ROW_UNREADABLE_MESSAGE).not.toBe(CONTACT_ROW_WRITE_FAILED_MESSAGE);
  });

  test('ГРАНИЦА: строки нет — по-прежнему тихо, переименовывать нечего', async () => {
    const peer = makeKeyPair();
    await expect(renameContact(b64(peer.publicKey), 'Маргарита')).resolves.toBeUndefined();
    expect(kv[rowKey(peer.publicKey)]).toBeUndefined();
  });

  test('ГРАНИЦА: профиль собеседника в строке переживает переименование', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Рита');
    const before = JSON.parse(kv[rowKey(peer.publicKey)]) as Record<string, unknown>;
    await renameContact(b64(peer.publicKey), 'Маргарита');
    const after = JSON.parse(kv[rowKey(peer.publicKey)]) as Record<string, unknown>;
    expect(after.symKey).toBe(before.symKey);
  });
});

const SRC = fs.readFileSync(path.join(__dirname, '..', 'contacts.ts'), 'utf8');

describe('форма правки', () => {
  test('переименование спрашивает разбор тремя состояниями, как addContact', () => {
    const at = SRC.indexOf('export async function renameContact(');
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, SRC.indexOf('\n}', at));
    expect(body).toContain('const cell = await contactRowCell(pid, peerPublicKeyB64);');
    expect(body).toContain('if (!mayOverwrite(cell)) throw new Error(CONTACT_ROW_UNREADABLE_MESSAGE);');
    expect(body).toContain('const row = cellTextOrNull(cell);');
    expect(body).not.toContain('contactRowGet(');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {

  test('contactRowGet и правда сводит два ответа к одному null', () => {
    expect(SRC).toContain(
      'async function contactRowGet(pid: number, peerPubB64: string): Promise<string | null> {\n' +
        '  return cellTextOrNull(await contactRowCell(pid, peerPubB64)) || null;\n' +
        '}'
    );
  });

});
