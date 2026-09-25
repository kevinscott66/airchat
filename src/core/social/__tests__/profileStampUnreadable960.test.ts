/**
 * Непрочитанная отметка версии профиля больше не выдаётся за «отметки нет»
 * (v4.32.960).
 *
 * ДЕФЕКТ. `buildEnvelope` брала отметку через `scopedKvGetFor`, а та сводит
 * отказ базы и отсутствие записи к одному `null`. Занятый SQLite приводил сюда
 * `stamp = 0`, то есть ветку «первый запуск после обновления», — и она писала
 * поверх НАСТОЯЩЕЙ отметки сегодняшнее время.
 *
 * ЦЕНА. Свёртка версии считается от отметки. Изменилась отметка — изменилась
 * версия, `sent[peer] === version` перестаёт совпадать, и карточка (имя,
 * @имя, «О себе», местоимения, статус, фотография, бумага на галочку,
 * привязки) уезжает заново КАЖДОМУ контакту. Настоящая отметка при этом
 * потеряна навсегда: следующий заход прочитает уже подменённую. А если и
 * запись не легла, «сейчас» остаётся только в памяти, и каждый следующий вызов
 * собирает новую версию из ничего — открытие любой переписки становится
 * рассылкой. Ровно этот круг запрещает комментарий в самой функции.
 *
 * ПРАВКА. Отметка спрашивается тремя состояниями: `null` — «не прочитали», и
 * тогда конверт не собирается вовсе. Ответ записи первой отметки читается по
 * той же причине. Рассылка молча пропускает заход, точечная досылка отвечает
 * `failed` — чтобы просьба о карточке считалась неотвеченной и повтор её
 * переспросил.
 *
 * ГРАНИЦЫ. Отсутствие записи по-прежнему заводит первую отметку и рассылает:
 * это обычный первый запуск, а не беда. Пустой профиль по-прежнему тихо
 * пропускается.
 */

/** Значения профильного kv: ключ → строка. */
let mockKv: Record<string, string> = {};
/** Ключи (логические), чтение которых отказывает. */
let mockReadFail = new Set<string>();
/** Ключи, запись которых отказывает. */
let mockWriteFail = new Set<string>();
/** Что реально записали — чтобы поймать затирание настоящей отметки. */
let mockWrites: { key: string; value: string }[] = [];

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: async (_pid: number, key: string) =>
    (mockReadFail.has(key) ? null : { value: mockKv[key] ?? null }),
  scopedKvGetFor: async (_pid: number, key: string) =>
    (mockReadFail.has(key) ? null : mockKv[key] ?? null),
  scopedKvSetCheckedFor: async (_pid: number, key: string, value: string) => {
    if (mockWriteFail.has(key)) return false;
    mockKv[key] = value;
    mockWrites.push({ key, value });
    return true;
  },
  scopedKvSetFor: async (_pid: number, key: string, value: string) => {
    if (mockWriteFail.has(key)) return;
    mockKv[key] = value;
    mockWrites.push({ key, value });
  },
  scopedKvSet: async (key: string, value: string) => { mockKv[key] = value; },
  scopedKvTryGetSecretFor: async (_pid: number, key: string) =>
    (mockReadFail.has(key) ? null : { value: mockKv[key] ?? null }),
  scopedKvSetSecretCheckedFor: async (_pid: number, key: string, value: string) => {
    if (mockWriteFail.has(key)) return false;
    mockKv[key] = value;
    return true;
  },
}));

/** Кому ушёл конверт профиля. */
let mockSent: string[] = [];

jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: async (peer: string) => { mockSent.push(peer); return 'cid1'; },
  }),
}));

let mockContacts: { peerPublicKey: string }[] = [];
jest.mock('../contacts', () => ({
  listContactsFor: async () => mockContacts,
  setPeerProfileForChecked: async () => true,
  isMyContact: async () => true,
}));

jest.mock('../sendGate', () => ({ canReachPeer: async () => true }));
jest.mock('../../settings/avatarVisibility', () => ({ avatarVisibilityTryFor: async () => 'all' }));
jest.mock('../publicAvatar', () => ({ publishOwnAvatarToDirectory: async () => undefined }));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 7 }) },
}));

/** Имя владельца; пустая строка — профиль не заполнен. */
let mockOwnName = 'Аня';
jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: async () => mockOwnName,
  getOwnUsernameFor: async () => null,
  ownFieldGetFor: async () => null,
}));
jest.mock('../../identity/ownAvatar', () => ({
  ownAvatarNameFor: async () => null,
  ownAvatarUriFor: async () => null,
}));
jest.mock('../../identity/ownBadge', () => ({ ownBadgeGrantFor: async () => null }));
jest.mock('../../identity/ownLinks', () => ({ ownLinksFor: async () => null }));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { broadcastMyProfile, handleIncomingProfileRequest } from '../profileSync';

const PEER = 'P'.repeat(43);
const STAMP_KEY = 'profile:changed_at';
/** Настоящая отметка правки: заметно в прошлом, чтобы подмену было видно. */
const REAL_STAMP = 1_700_000_000_000;

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const SRC = codeOnly(readFileSync(join(__dirname, '..', 'profileSync.ts'), 'utf8'));

beforeEach(() => {
  mockKv = {};
  mockReadFail = new Set();
  mockWriteFail = new Set();
  mockWrites = [];
  mockSent = [];
  mockContacts = [{ peerPublicKey: PEER }];
  mockOwnName = 'Аня';
});

describe('отметку версии не прочитали — карточка не уезжает заново', () => {
  it('рассылка молчит, а не рассылает всем по выдуманной версии', async () => {
    mockKv[STAMP_KEY] = String(REAL_STAMP);
    mockReadFail.add(STAMP_KEY);
    await broadcastMyProfile();
    expect(mockSent).toEqual([]);
  });

  it('настоящая отметка не затирается сегодняшним временем', async () => {
    mockKv[STAMP_KEY] = String(REAL_STAMP);
    mockReadFail.add(STAMP_KEY);
    await broadcastMyProfile();
    expect(mockWrites.filter((w) => w.key === STAMP_KEY)).toEqual([]);
    expect(mockKv[STAMP_KEY]).toBe(String(REAL_STAMP));
  });

  it('первая отметка не легла — тоже не рассылаем: версия была бы разовой', async () => {
    mockWriteFail.add(STAMP_KEY);
    await broadcastMyProfile();
    expect(mockSent).toEqual([]);
  });

  it('просьба о карточке остаётся неотвеченной, а не «отвеченной пустотой»', async () => {
    mockKv[STAMP_KEY] = String(REAL_STAMP);
    mockReadFail.add(STAMP_KEY);
    const { encodeProfileRequest } = await import('../profileEnvelope');
    await expect(handleIncomingProfileRequest(encodeProfileRequest(), PEER, 7))
      .resolves.toBe('deferred');
    expect(mockSent).toEqual([]);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Молчание — дорогой ответ: карточка не доедет до этого захода. Оно позволено
 * ровно там, где версия неизвестна; исправная база обязана работать как
 * работала, иначе правка меняет не беду, а поведение.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: исправная база рассылает как прежде', () => {
  it('отметка на месте — конверт уходит контакту', async () => {
    mockKv[STAMP_KEY] = String(REAL_STAMP);
    await broadcastMyProfile();
    expect(mockSent).toEqual([PEER]);
  });

  it('второй заход той же версии молчит — круга рассылки нет', async () => {
    mockKv[STAMP_KEY] = String(REAL_STAMP);
    await broadcastMyProfile();
    mockSent = [];
    await broadcastMyProfile();
    expect(mockSent).toEqual([]);
  });

  it('отметки нет — она заводится и рассылка идёт (первый запуск)', async () => {
    await broadcastMyProfile();
    expect(mockSent).toEqual([PEER]);
    expect(mockKv[STAMP_KEY]).toBeTruthy();
  });

  it('ГРАНИЦА: пустой профиль по-прежнему тихо пропускается', async () => {
    mockOwnName = '';
    mockKv[STAMP_KEY] = String(REAL_STAMP);
    await broadcastMyProfile();
    expect(mockSent).toEqual([]);
  });
});

describe('форма исходников: отметку спрашивают тремя состояниями', () => {
  it('сборка конверта читает scopedKvTryGetFor и отвечает словом', () => {
    const at = SRC.indexOf('async function buildEnvelope(');
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, SRC.indexOf('\nexport async function markProfileChanged(', at));
    expect(body).toContain('await scopedKvTryGetFor(pid, CHANGED_AT_KEY)');
    expect(body).toContain("return 'unreadable';");
    expect(body).toContain('await scopedKvSetCheckedFor(pid, CHANGED_AT_KEY, String(stamp))');
    expect(body).not.toContain('await scopedKvGetFor(pid, CHANGED_AT_KEY)');
  });

  it('досылка различает «нечего слать» и «не знаем версию»', () => {
    const at = SRC.indexOf('async function sendProfileTo(');
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, at + 1600);
    expect(body).toContain("if (built === 'empty') return 'skipped';");
    expect(body).toContain("if (built === 'unreadable') return 'failed';");
  });
});
