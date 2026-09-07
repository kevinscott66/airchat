/**
 * Блокировка действует и при закрытом приложении (v4.32.615).
 *
 * Решение v4.32.318 записано в callService прямым текстом: блокировка означает
 * «этот человек со мной не связывается», и звонок из неё не исключение —
 * звонящему полагается видеть ровно то же, что при выключенном телефоне.
 * Держалась эта договорённость на одной проверке в onOffer, то есть в живом
 * сокете сигналинга. С v4.32.573 у звонка появился второй канал: push поднимает
 * полноэкранный баннер поверх экрана блокировки, и onOffer до него не доходит —
 * приложение в этот момент закрыто. Заблокированный человек снова звонил на
 * весь дом ровно тем каналом, который в v4.32.318 и закрывали.
 *
 * То же и с личным сообщением: конверт от заблокированного отбрасывается в
 * messaging, но push отправитель шлёт независимо от того, приняли ли конверт.
 * Группы сюда не относятся — групповое сообщение переживает блокировку
 * намеренно (blockPolicy: заблокирован человек, а не общая беседа).
 *
 * Список с v4.32.286 лежит шифртекстом, и открытым его не сделать: строка
 * блок-листа отвечает на вопрос «с кем человек поссорился» в базе, где само
 * общение спрятано. Значит, при недоступном ключе список не прочитается — и
 * тогда баннер показывается. Так и задумано: молча съесть звонок хуже, чем
 * показать лишний баннер.
 */
import * as fs from 'fs';
import * as path from 'path';

import { didFromPubB64 } from '../../core/identity/did';
import { BLOCKED_KEY_BASE, legacySuffixBlockedKey, profileScopedKey } from '../../core/storage/kvKeys';

let mockKv: Record<string, string> = {};
let mockOpenFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    if (mockOpenFails) throw new Error('SQLITE_CANTOPEN: unable to open database file');
    return {
      getFirstAsync: jest.fn(async (_sql: string, params: string[]) => {
        const v = mockKv[params[0]];
        return v === undefined ? null : { v };
      }),
      getAllAsync: jest.fn(async (sql: string, params?: string[]) => {
        const keys = params ?? [];
        if (!/WHERE k IN/.test(sql)) return [];
        return keys.filter((k) => mockKv[k] !== undefined).map((k) => ({ k, v: mockKv[k] }));
      }),
      runAsync: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
      execAsync: jest.fn(async () => undefined),
      closeAsync: jest.fn(async () => undefined),
    };
  }),
}));

// Ключ и разбор ячейки при закрытом приложении. Подмена нужна ровно затем,
// чтобы отдельно проверить два исхода: ключ есть и ключ недоступен.
let mockDekAvailable = true;
const ENC_PREFIX = 'enc2:';
jest.mock('../../core/storage/localEncryption', () => ({
  readDekFromSecureStoreRaw: jest.fn(async () => (mockDekAvailable ? new Uint8Array(32).fill(7) : null)),
  tryDecryptAtRest: jest.fn((stored: string) =>
    stored.startsWith(ENC_PREFIX) ? Buffer.from(stored.slice(ENC_PREFIX.length), 'base64').toString('utf8') : stored
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isBackgroundBlocked } = require('../backgroundBlockList') as typeof import('../backgroundBlockList');

const MIRROR = 'active_profile_id';

function pub(n: number): string {
  return Buffer.from(new Uint8Array(32).fill(n)).toString('base64');
}
function did(n: number): string {
  const d = didFromPubB64(pub(n));
  if (!d) throw new Error('did');
  return d;
}
/** Так список и лежит в базе: JSON-массив base64-ключей под замком. */
function cell(pubs: string[]): string {
  return ENC_PREFIX + Buffer.from(JSON.stringify(pubs), 'utf8').toString('base64');
}

beforeEach(() => {
  mockKv = {};
  mockOpenFails = false;
  mockDekAvailable = true;
});

describe('блок-лист в фоновом контексте', () => {
  it('узнаёт заблокированного по его did', async () => {
    mockKv[MIRROR] = '2';
    mockKv[profileScopedKey(2, BLOCKED_KEY_BASE)] = cell([pub(1)]);
    expect(await isBackgroundBlocked(did(1))).toBe(true);
  });

  it('не трогает никого, кроме тех, кто в списке', async () => {
    mockKv[MIRROR] = '2';
    mockKv[profileScopedKey(2, BLOCKED_KEY_BASE)] = cell([pub(1)]);
    expect(await isBackgroundBlocked(did(2))).toBe(false);
  });

  it('читает список чужого профиля не своим ключом', async () => {
    mockKv[MIRROR] = '2';
    mockKv[profileScopedKey(3, BLOCKED_KEY_BASE)] = cell([pub(1)]);
    expect(await isBackgroundBlocked(did(1))).toBe(false);
  });

  it('понимает старое имя с суффиксом профиля', async () => {
    mockKv[MIRROR] = '2';
    mockKv[legacySuffixBlockedKey(2)] = cell([pub(1)]);
    expect(await isBackgroundBlocked(did(1))).toBe(true);
  });

  it('запись без префикса принадлежит первому профилю', async () => {
    mockKv[BLOCKED_KEY_BASE] = cell([pub(1)]);
    expect(await isBackgroundBlocked(did(1))).toBe(true);
  });

  it('запись без префикса не действует на второй профиль', async () => {
    mockKv[MIRROR] = '2';
    mockKv[BLOCKED_KEY_BASE] = cell([pub(1)]);
    expect(await isBackgroundBlocked(did(1))).toBe(false);
  });

  it('нынешнее имя старше суффиксного', async () => {
    mockKv[MIRROR] = '1';
    mockKv[profileScopedKey(1, BLOCKED_KEY_BASE)] = cell([]);
    mockKv[legacySuffixBlockedKey(1)] = cell([pub(1)]);
    expect(await isBackgroundBlocked(did(1))).toBe(false);
  });

  it('недоступный ключ означает показать баннер', async () => {
    mockKv[BLOCKED_KEY_BASE] = cell([pub(1)]);
    mockDekAvailable = false;
    expect(await isBackgroundBlocked(did(1))).toBe(false);
  });

  it('недоступная база означает показать баннер', async () => {
    mockKv[BLOCKED_KEY_BASE] = cell([pub(1)]);
    mockOpenFails = true;
    expect(await isBackgroundBlocked(did(1))).toBe(false);
  });

  it('мусор вместо списка не роняет обработчик', async () => {
    mockKv[BLOCKED_KEY_BASE] = ENC_PREFIX + Buffer.from('{не json', 'utf8').toString('base64');
    expect(await isBackgroundBlocked(did(1))).toBe(false);
  });

  it('пустой did никого не блокирует', async () => {
    mockKv[BLOCKED_KEY_BASE] = cell([pub(1)]);
    expect(await isBackgroundBlocked(undefined)).toBe(false);
    expect(await isBackgroundBlocked('не did')).toBe(false);
  });
});

describe('форма кода', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'firebaseMessagingBackground.ts'), 'utf8');
  // Слова «блок-лист» встречаются в пояснениях чаще, чем в коде: сверяем код.
  const CODE = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('баннер звонка спрашивает блок-лист до показа', () => {
    const fn = CODE.slice(
      CODE.indexOf('async function showIncomingCallBanner'),
      CODE.indexOf('async function senderDidOf')
    );
    expect(fn).not.toBe('');
    expect(fn).toContain('if (await isBackgroundBlocked(contactDid)) return;');
    expect(fn.indexOf('isBackgroundBlocked')).toBeLessThan(fn.indexOf('displayNotification'));
  });

  it('личное сообщение спрашивает блок-лист до показа', () => {
    const handler = CODE.slice(CODE.indexOf('setBackgroundMessageHandler'));
    expect(handler).toContain("if (kind === 'dm' && (await isBackgroundBlocked(contactDid))) return;");
    expect(handler.indexOf('isBackgroundBlocked(contactDid)')).toBeLessThan(
      handler.indexOf('displayNotification')
    );
  });

  it('группу блок-лист не глушит', () => {
    const handler = CODE.slice(CODE.indexOf('setBackgroundMessageHandler'));
    // Единственное обращение в обработчике сообщений — под условием «личное».
    const calls = handler.match(/await isBackgroundBlocked\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(handler).toContain("kind === 'dm' && (await isBackgroundBlocked(contactDid))");
  });
});
