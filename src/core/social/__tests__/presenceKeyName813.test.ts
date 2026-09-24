/**
 * Имя ключа присутствия перестало называть собеседника (v4.32.813).
 *
 * Дефект. Время последнего входа лежало под именем
 * `presence:last_seen:<открытый ключ собеседника>`. Столбцы `k` и `v` таблицы
 * `kv` открыты: шифруются выбранные значения переписки ключом из Keychain, а
 * структура базы — нет. Значение здесь и правда безобидно, это число; всё
 * сказано именем.
 *
 * Цена. Набор таких имён — готовый граф связей: с кем человек переписывается
 * (включая тех, кого он не заводил в контакты, — им время тоже копилось) и
 * когда каждый из них последний раз был в сети. Унёсший файл базы без доступа
 * к Keychain читать переписку не может, а этот список прочитывал целиком —
 * то есть имя ключа отменяло работу шифрования значения. Для приложения,
 * которым пользуются ради того, чтобы связь не была видна со стороны, это
 * дороже содержания отдельного сообщения.
 *
 * Правка. Окончание имени — HMAC на ключе, выведенном HKDF из ключа данных.
 * Простого sha256 мало: открытых ключей конечное число, и по списку
 * кандидатов дайджест подбирается перебором; HMAC на секрете из Keychain
 * такой перебор закрывает. Разовый перенос при загрузке присутствия
 * переставляет старые записи под новые имена — копия, и только потом снятие
 * старой. Удаление контакта снимает оба имени: перенос мог до этой записи
 * ещё не дойти.
 */
const mockKv = new Map<string, string>();
/** Ключи, запись которых база не выполняет. */
const mockFailWrites = new Set<string>();
/** Ключи, чтение которых база не выполняет («не ответила», а не «пусто»). */
const mockFailReads = new Set<string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockFailReads.has(k) ? null : { value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvSetChecked: async (k: string, v: string) => {
    if (mockFailWrites.has(k)) return false;
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvDeleteChecked: async (k: string) => { mockKv.delete(k); return true; },
  kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
  // v4.32.814: список «не отмечай меня» лёг в секретную пару — без неё
  // служба читает «не знаем» и перестаёт писать время входа.
  kvSetSecret: async (k: string, v: string) => {
    if (mockFailWrites.has(k)) return false;
    mockKv.set(k, v);
    return true;
  },
  kvGetSecretCellScoped: async (pid: number, k: string) => {
    const scoped = `p${pid}:${k}`;
    if (mockFailReads.has(scoped)) return { state: 'unreadable' };
    const raw = mockKv.get(scoped);
    return raw === undefined ? { state: 'absent' } : { state: 'plain', text: raw };
  },
}));

// Ключ данных лежит в Keychain; здесь он постоянный — иначе дайджест менялся
// бы от проверки к проверке, а речь не о нём.
jest.mock('../../storage/localEncryption', () => ({
  getOrCreateDataEncryptionKey: async () => new Uint8Array(32).fill(7),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, name: 'П', did: 'did:key:z1' }),
    getAllProfiles: () => [{ id: 1, name: 'Личный', did: 'did:key:z1' }],
  },
}));

jest.mock('../../identity/ownProfile', () => ({ ownFieldGetFor: async () => '' }));
jest.mock('../../transport/ipfs/pubsub', () => ({ pubsubPublish: async () => null, pubsubSubscribe: async () => null }));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => false }));
jest.mock('../contacts', () => ({ listContacts: async () => [], listContactsFor: async () => [] }));
jest.mock('../../settings/privacyPrefs', () => ({ privacyPrefTryGet: async () => ({ value: 'everybody' }) }));
jest.mock('../../logger', () => ({ log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } }));
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }), currentState: 'active' } }));

import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  getPresenceState,
  legacyPresenceLastSeenKey,
  loadPersistedPresence,
  presenceLastSeenKey,
  recordPeerActivity,
  stopPresenceBroadcast,
} from '../presenceService';
import { keyNameDigest, looksLikeKeyNameDigest } from '../../storage/keyNameDigest';

const PREFIX = 'presence:last_seen:';
const PEER = 'ключСобеседника==';
const OTHER = 'ключДругого==';
const PID = 2;
const WHEN = 1_700_000_000_000;

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** Дать волю void-записям в kv: они не ожидаются вызывающим. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/** Все имена присутствия, как они лежат в базе. */
function presenceKeys(): string[] {
  return [...mockKv.keys()].filter((k) => k.includes(PREFIX));
}

beforeEach(async () => {
  mockKv.clear();
  mockFailWrites.clear();
  mockFailReads.clear();
  await stopPresenceBroadcast();
});

describe('имя ключа не выдаёт, с кем переписываются', () => {
  it('открытого ключа собеседника в именах нет', async () => {
    await loadPersistedPresence([], PID);
    recordPeerActivity(PEER, WHEN);
    await settle();
    expect(presenceKeys().length).toBe(1);
    for (const k of presenceKeys()) expect(k).not.toContain(PEER);
  });

  it('окончание имени — шестнадцатеричный дайджест известной длины', async () => {
    const key = await presenceLastSeenKey(PEER);
    const suffix = key.slice(PREFIX.length);
    expect(key.startsWith(PREFIX)).toBe(true);
    expect(looksLikeKeyNameDigest(suffix)).toBe(true);
  });

  it('разным собеседникам — разные имена, одному и тому же — одно', async () => {
    expect(await presenceLastSeenKey(PEER)).not.toBe(await presenceLastSeenKey(OTHER));
    expect(await presenceLastSeenKey(PEER)).toBe(await presenceLastSeenKey(PEER));
  });

  it('дайджест не подбирается перебором открытых ключей', async () => {
    // Простой sha256 по списку кандидатов вскрывается за секунды: открытых
    // ключей в сети конечное число. Поэтому дайджест обязан зависеть от
    // секрета, а не только от значения, — и с голым хешем не совпадать.
    const plain = Buffer.from(sha256(new TextEncoder().encode(PEER))).toString('hex');
    const digest = await keyNameDigest(PEER);
    expect(plain.startsWith(digest)).toBe(false);
    expect(plain).not.toContain(digest);
  });
});

describe('перенос старых имён при загрузке', () => {
  it('запись переезжает под дайджест, значение цело', async () => {
    mockKv.set(`p${PID}:${legacyPresenceLastSeenKey(PEER)}`, String(WHEN));
    await loadPersistedPresence([PEER], PID);
    expect(mockKv.get(`p${PID}:${await presenceLastSeenKey(PEER)}`)).toBe(String(WHEN));
    expect(mockKv.has(`p${PID}:${legacyPresenceLastSeenKey(PEER)}`)).toBe(false);
  });

  it('время после переноса читается, а не теряется', async () => {
    // Иначе первый запуск после обновления показал бы всех «не в сети», и
    // приложение выглядело бы так, будто переписки не было.
    mockKv.set(`p${PID}:${legacyPresenceLastSeenKey(PEER)}`, String(WHEN));
    await loadPersistedPresence([PEER], PID);
    expect(getPresenceState(PEER).lastActiveAt).toBe(WHEN);
  });

  it('несостоявшаяся копия оставляет старую запись на месте', async () => {
    // Снять, не скопировав, — потерять насовсем; следующий запуск попробует
    // снова, и в этом весь смысл порядка «сначала копия».
    mockKv.set(`p${PID}:${legacyPresenceLastSeenKey(PEER)}`, String(WHEN));
    mockFailWrites.add(`p${PID}:${await presenceLastSeenKey(PEER)}`);
    await loadPersistedPresence([PEER], PID);
    expect(mockKv.get(`p${PID}:${legacyPresenceLastSeenKey(PEER)}`)).toBe(String(WHEN));
  });

  it('не прочитавшуюся запись перенос не трогает', async () => {
    mockKv.set(`p${PID}:${legacyPresenceLastSeenKey(PEER)}`, String(WHEN));
    mockFailReads.add(`p${PID}:${legacyPresenceLastSeenKey(PEER)}`);
    await loadPersistedPresence([PEER], PID);
    expect(mockKv.get(`p${PID}:${legacyPresenceLastSeenKey(PEER)}`)).toBe(String(WHEN));
  });

  it('уже перенесённые имена не перебираются заново', async () => {
    const digestKey = `p${PID}:${await presenceLastSeenKey(PEER)}`;
    mockKv.set(digestKey, String(WHEN));
    await loadPersistedPresence([PEER], PID);
    expect(mockKv.get(digestKey)).toBe(String(WHEN));
    expect(presenceKeys()).toEqual([digestKey]);
  });

  it('переносятся и те, кого нет в списке на чтение', async () => {
    // Самая говорящая часть утечки — как раз те, кто в контакты не попал:
    // время им копилось, а на экране они не показываются никогда.
    mockKv.set(`p${PID}:${legacyPresenceLastSeenKey(OTHER)}`, String(WHEN));
    await loadPersistedPresence([], PID);
    expect(mockKv.has(`p${PID}:${await presenceLastSeenKey(OTHER)}`)).toBe(true);
    expect(mockKv.has(`p${PID}:${legacyPresenceLastSeenKey(OTHER)}`)).toBe(false);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: присутствие работает как прежде', () => {
  it('время записывается и поднимается после перезапуска', async () => {
    await loadPersistedPresence([], PID);
    recordPeerActivity(PEER, WHEN);
    await settle();
    await stopPresenceBroadcast();
    await loadPersistedPresence([PEER], PID);
    expect(getPresenceState(PEER).lastActiveAt).toBe(WHEN);
  });

  it('запись остаётся в namespace своего профиля', async () => {
    await loadPersistedPresence([], PID);
    recordPeerActivity(PEER, WHEN);
    await settle();
    expect(presenceKeys().every((k) => k.startsWith(`p${PID}:`))).toBe(true);
  });

  it('чужая запись не поднимается соседним профилем', async () => {
    await loadPersistedPresence([], PID);
    recordPeerActivity(PEER, WHEN);
    await settle();
    await stopPresenceBroadcast();
    await loadPersistedPresence([PEER], 3);
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: имя ключа ложится на диск открытым', () => {
  it('kv пишется без шифрования имени и значения', () => {
    const local = codeOnly(read('core', 'storage', 'local.ts'));
    const at = local.indexOf('export async function kvSetChecked(');
    expect(at).toBeGreaterThan(0);
    const body = local.slice(at, local.indexOf('\n}', at));
    expect(body).toContain("'INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [key, value]");
    // Ни имя, ни значение не проходят через шифрование столбцов — значит всё,
    // что названо в имени, читается из украденного файла базы как есть.
    expect(body).not.toContain('encryptAtRest');
  });

  it('шифрование при этом существует и применяется к содержанию', () => {
    // Иначе речь шла бы о базе, открытой целиком, и отдельного дефекта в
    // имени ключа не было бы.
    const enc = codeOnly(read('core', 'storage', 'localEncryption.ts'));
    expect(enc).toContain('export function encryptAtRestString(');
    expect(enc).toContain('export function getOrCreateDataEncryptionKey(): Promise<Uint8Array> {');
  });
});

describe('форма исходников: дайджест, перенос, уборка за контактом', () => {
  it('имя собирается дайджестом, а не открытым ключом', () => {
    const s = codeOnly(read('core', 'social', 'presenceService.ts'));
    expect(s).toContain('return `${KV_PREFIX}${await keyNameDigest(peerPubB64)}`;');
    expect(s).not.toContain('export function presenceLastSeenKey(peerPubB64: string): string {');
  });

  it('старое имя осталось названным — его ещё снимать', () => {
    const s = codeOnly(read('core', 'social', 'presenceService.ts'));
    expect(s).toContain('export function legacyPresenceLastSeenKey(peerPubB64: string): string {');
    expect(s).toContain('await migrateLastSeenKeyNames(presencePid);');
  });

  it('перенос копирует проверяемо и только потом снимает старое', () => {
    const s = codeOnly(read('core', 'social', 'presenceService.ts'));
    const at = s.indexOf('async function migrateLastSeenKeyNames(');
    expect(at).toBeGreaterThan(0);
    const body = s.slice(at, s.indexOf('\n}\n', at));
    const copy = body.indexOf('scopedKvSetCheckedFor(');
    const drop = body.indexOf('scopedKvDeleteFor(');
    expect(copy).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(copy);
    expect(body).toContain('looksLikeKeyNameDigest(suffix)');
  });

  it('дайджест берётся HMAC-ом на ветке ключа данных, а не хешем значения', () => {
    const s = codeOnly(read('core', 'storage', 'keyNameDigest.ts'));
    expect(s).toContain('const derived = hkdf(sha256, dek, new Uint8Array(0), KEY_NAME_INFO, 32);');
    expect(s).toContain('const mac = hmac(sha256, key, new TextEncoder().encode(value));');
    expect(s).toContain("import { getOrCreateDataEncryptionKey } from './localEncryption';");
  });

  it('удаление контакта снимает оба имени', () => {
    const s = codeOnly(read('core', 'social', 'contacts.ts'));
    expect(s).toContain('const legacyKey = legacyPresenceLastSeenKey(peerPublicKeyB64);');
    expect(s).toContain('const digestKey = await presenceLastSeenKey(peerPublicKeyB64);');
    expect(s).toContain('await kvDeleteScoped(pid, legacyKey);');
    expect(s).toContain('await kvDeleteScoped(pid, digestKey);');
  });
});
