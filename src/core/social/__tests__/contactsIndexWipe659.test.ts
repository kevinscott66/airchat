/**
 * Один недоступный момент базы не стирает записную книжку (v4.32.659).
 *
 * `contacts_index` — единственный список, по которому строится «Контакты».
 * Он перечитывается, меняется и кладётся обратно и в `rememberContactId`, и в
 * `deleteContact`. Чтение шло через `profileKvGet` → `kvGet`, а тот сводит
 * «записи нет» и «прочитать не смогли» в один null: сорванное чтение давало
 * пустой указатель, и на диск ложился он же — из одной записи (remember) или
 * пустой (delete). Теперь читает `scopedKvTryGetFor`, у которого отказ — это
 * null, отдельно от `{ value: null }`.
 */

let mockReadFails = false;

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
    // Заглушка ведёт себя как настоящая: отказ базы — это null, а не исключение
    // (kvTryGet гасит ошибку SQLite внутри себя, см. storage/local).
    kvTryGet: jest.fn(async (key: string) => {
      if (mockReadFails) return null;
      return { value: await kvGet(key) };
    }),
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
    kvSetSecret: jest.fn(async (key: string, value: string) => kvSet(key, value)),
    profileKvGet: jest.fn(async (profileId: number, key: string) => {
      if (mockReadFails) return null;
      return kvGet(`p${profileId}:${key}`);
    }),
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

import fs from 'fs';
import path from 'path';
import {
  deleteContact,
  invalidateContactsList,
  listContactsReadFor,
  rememberContactId,
} from '../contacts';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };
const kv = mockLocal.__kv;

const A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';

const INDEX_KEY = 'p1:contacts_index';

function indexNow(): string[] {
  const raw = kv[INDEX_KEY];
  return raw === undefined ? [] : (JSON.parse(raw) as string[]);
}

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  mockReadFails = false;
  // Модульный TTL-кэш списка иначе переживает очистку kv.
  invalidateContactsList();
});

describe('сорванное чтение указателя контактов не стирает список', () => {
  test('rememberContactId при отказе чтения оставляет указатель нетронутым', async () => {
    kv[INDEX_KEY] = JSON.stringify([A, B]);
    mockReadFails = true;

    await rememberContactId(C);

    // Прежде сюда ложился указатель из одной записи — C, — и A с B исчезали.
    expect(indexNow()).toEqual([A, B]);
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: при исправном чтении rememberContactId дописывает', async () => {
    kv[INDEX_KEY] = JSON.stringify([A, B]);

    await rememberContactId(C);

    expect(indexNow()).toEqual([A, B, C]);
  });

  test('deleteContact при отказе чтения не обрезает указатель, но строку удаляет', async () => {
    kv[INDEX_KEY] = JSON.stringify([A, B]);
    kv[`p1:contact:${A}`] = 'строка контакта A';
    mockReadFails = true;

    await deleteContact(A);

    // Указатель не переписан: '[]' на месте несостоявшегося чтения снёс бы и B.
    expect(indexNow()).toEqual([A, B]);
    // А человека просили удалить — его строки больше нет.
    expect(kv[`p1:contact:${A}`]).toBeUndefined();
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: при исправном чтении deleteContact убирает из указателя', async () => {
    kv[INDEX_KEY] = JSON.stringify([A, B]);
    kv[`p1:contact:${A}`] = 'строка контакта A';

    await deleteContact(A);

    expect(indexNow()).toEqual([B]);
    expect(kv[`p1:contact:${A}`]).toBeUndefined();
  });

  test('listContactsReadFor при отказе чтения отвечает null, а не пустым списком', async () => {
    kv[INDEX_KEY] = JSON.stringify([A]);
    mockReadFails = true;

    expect(await listContactsReadFor(1)).toBeNull();
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: пустой указатель — это пустой список, а не null', async () => {
    expect(await listContactsReadFor(1)).toEqual([]);
  });

  test('ПОВОД ДЛЯ ПРАВКИ ЖИВ: kvGet по-прежнему сводит отказ и пустоту в один null', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../storage/local.ts'), 'utf8');
    // Пока kvGet (и профильный profileKvGet поверх него) отвечает одним null и
    // на «нет записи», и на «не смогли прочитать», указателю контактов нужен
    // именно scopedKvTryGetFor — у него для этого три состояния.
    expect(src).toContain('return (await kvTryGet(key))?.value ?? null;');
    expect(src).toContain('return kvGet(profileScopedKey(profileId, key));');

    const contacts = fs.readFileSync(path.join(__dirname, '../contacts.ts'), 'utf8');
    // Ровно три места читают указатель — список, дозапись и удаление.
    expect(contacts.split("await scopedKvTryGetFor(pid, 'contacts_index')").length - 1)
      .toBe(3);
  });
});
