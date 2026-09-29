/**
 * v4.32.1031 — «копии нет» говорилось и тогда, когда посмотреть не смогли.
 *
 * Дефект. `hasAccountVaultSnapshot` отвечал одним `boolean` на два разных
 * вопроса. Опрос манифеста шёл через местный `exists`, а тот гасит бросок
 * `getInfoAsync` и отвечает «нет». Перед опросом зовётся подъёмник застрявших
 * под `.previous-…` копий, и он тоже молчит: отказ чтения каталога читается
 * как «застрявших нет», отказ переезда — как «не подняли, и ладно». Во всех
 * трёх случаях наружу уходило «снимка нет» — неотличимо от чистого
 * устройства.
 *
 * Цена. Спрашивают об этом в `restoreFromMnemonic`, и «нет» там значит
 * «восстанавливать нечего, профиль заведётся чистым». Человек вводит свои
 * секретные слова, видит рапорт об успехе и попадает в пустой аккаунт: ни
 * переписки, ни контактов, ни профилей, — а копия всё это время лежит на
 * диске целой. Дальше он делает единственное, что подсказывает такой экран:
 * выходит и восстанавливает заново. Выход — это `performLocalWalletWipe`, а в
 * нём `deleteAccountVault`. Копия, которая была на месте, уносится совсем.
 * Второй, отдельный случай: при смене кошелька «нет» толкает человека выйти
 * из ТЕКУЩЕГО кошелька, хотя разрешение остаться как раз и давала местная
 * копия нового seed'а.
 *
 * Правка. Состояние копии отвечает тремя словами
 * (`accountVaultSnapshotState`): `present`, `absent`, `unknown`. Опрос
 * манифеста строгий, подъёмник докладывает, удалось ли ему посмотреть, и
 * «не знаем» до вызывающего доходит словом, а не самым спокойным из ответов.
 *
 * Границы. Файловая система поддельная, в памяти. Цепочку до экрана
 * восстановления проверяет соседний
 * `core/backup/__tests__/restoreSnapshotUnknown1031.test.ts`: там видно, что
 * именно происходило с человеком. Здесь — только честность самого ответа.
 * Проверки нового ответа до правки падают на отсутствии экспорта, поэтому
 * контрольные блоки ниже нарочно написаны на прежних, уже существовавших
 * дверях: они показывают, что подделка ФС рабочая и что повод жив.
 */
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const mockSecure = new Map<string, string>();
/** Пути, чтение каталога по которым отказывает. */
const mockFailReadDir = new Set<string>();
/** Пути, опрос существования которых отказывает. */
const mockFailInfo = new Set<string>();
/** Переезд, начинающийся с этого пути, отказывает. */
let mockFailMoveFrom = '';

function mockChildren(uri: string): string[] {
  const prefix = uri.endsWith('/') ? uri : `${uri}/`;
  const names = new Set<string>();
  for (const path of [...mockFiles.keys(), ...mockDirs]) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    names.add(slash < 0 ? rest : rest.slice(0, slash));
  }
  return [...names];
}

function mockPathExists(uri: string): boolean {
  if (mockFiles.has(uri) || mockDirs.has(uri)) return true;
  if (!uri.endsWith('/')) return false;
  for (const key of [...mockFiles.keys(), ...mockDirs]) if (key.startsWith(uri)) return true;
  return false;
}

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/doc/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: jest.fn(async (uri: string) => {
    if (mockFailInfo.has(uri)) throw new Error(`info failed ${uri}`);
    return { exists: mockPathExists(uri) };
  }),
  makeDirectoryAsync: jest.fn(async (uri: string) => { mockDirs.add(uri); }),
  readDirectoryAsync: jest.fn(async (uri: string) => {
    if (mockFailReadDir.has(uri)) throw new Error(`readdir failed ${uri}`);
    return mockChildren(uri);
  }),
  copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const value = mockFiles.get(from);
    if (value === undefined) throw new Error(`missing ${from}`);
    mockFiles.set(to, value);
  }),
  writeAsStringAsync: jest.fn(async (uri: string, value: string) => { mockFiles.set(uri, value); }),
  readAsStringAsync: jest.fn(async (uri: string) => mockFiles.get(uri) ?? ''),
  deleteAsync: jest.fn(async (uri: string) => {
    const prefix = uri.endsWith('/') ? uri : `${uri}/`;
    const hit = (key: string): boolean => key === uri || key.startsWith(prefix);
    for (const key of [...mockFiles.keys()]) if (hit(key)) mockFiles.delete(key);
    for (const key of [...mockDirs]) if (hit(key)) mockDirs.delete(key);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    if (mockFailMoveFrom && from.startsWith(mockFailMoveFrom)) throw new Error(`move failed ${from}`);
    for (const key of [...mockFiles.keys()]) {
      if (!key.startsWith(from)) continue;
      mockFiles.set(`${to}${key.slice(from.length)}`, mockFiles.get(key)!);
      mockFiles.delete(key);
    }
    for (const key of [...mockDirs]) {
      if (!key.startsWith(from)) continue;
      mockDirs.add(`${to}${key.slice(from.length)}`);
      mockDirs.delete(key);
    }
  }),
}));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecure.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecure.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecure.delete(key); }),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { PROFILE_STATE_KEY } from '../../identity/profileStateKey';
import {
  accountVaultIdFromMnemonic,
  restoreAccountVault,
  snapshotAccountVault,
} from '../accountVault';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ROOT = '/doc/airchat_account_vault_v1/';
const STATE = JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Александр' }] });

const accountId = (): string => accountVaultIdFromMnemonic(MNEMONIC);
const vaultDir = (): string => `${ROOT}${accountId()}/`;
const manifestUri = (): string => `${vaultDir()}manifest.json`;

/** Новый ответ берётся через `import`: до правки его в модуле нет. */
async function state(): Promise<string> {
  const m = (await import('../accountVault')) as unknown as {
    accountVaultSnapshotState: (mnemonic: string) => Promise<string>;
  };
  return m.accountVaultSnapshotState(MNEMONIC);
}

async function snapshot(): Promise<boolean> {
  mockSecure.set(PROFILE_STATE_KEY, STATE);
  return snapshotAccountVault(MNEMONIC, STATE);
}

/**
 * Оставить копию под `.previous-…` — так её оставляет убитое в середине
 * замены приложение: по своему имени копии нет, а на диске она целая.
 */
async function strandVault(): Promise<string> {
  expect(await snapshot()).toBe(true);
  const name = `.previous-${accountId()}-1700000000000`;
  const from = vaultDir();
  const to = `${ROOT}${name}/`;
  for (const key of [...mockFiles.keys()]) {
    if (!key.startsWith(from)) continue;
    mockFiles.set(`${to}${key.slice(from.length)}`, mockFiles.get(key)!);
    mockFiles.delete(key);
  }
  // Вложенные каталоги переносятся тоже: иначе прежний путь останется
  // «существующим», подъёмник решит, что копия на месте, и не станет искать.
  for (const key of [...mockDirs]) {
    if (!key.startsWith(from)) continue;
    mockDirs.add(`${to}${key.slice(from.length)}`);
    mockDirs.delete(key);
  }
  return name;
}

function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const VAULT = readFileSync(join(__dirname, '..', 'accountVault.ts'), 'utf8');
const SEED = readFileSync(join(__dirname, '..', '..', 'backup', 'seedPhrase.ts'), 'utf8');
const APP = readFileSync(join(__dirname, '..', '..', '..', 'App.tsx'), 'utf8');

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockSecure.clear();
  mockFailReadDir.clear();
  mockFailInfo.clear();
  mockFailMoveFrom = '';
  mockFiles.set('/doc/SQLite/airchat_local.db', 'local ciphertext');
  mockFiles.set('/doc/SQLite/airchat_feed_p1.db', 'feed ciphertext');
});

describe('о копии счёта говорится тремя словами, а не двумя', () => {
  it('опрос манифеста отказал — это «не знаем», а не «нет»', async () => {
    expect(await snapshot()).toBe(true);
    mockFailInfo.add(manifestUri());
    expect(await state()).toBe('unknown');
  });

  it('копия застряла, а корень не прочитался — тоже «не знаем»', async () => {
    await strandVault();
    mockFailReadDir.add(ROOT);
    expect(await state()).toBe('unknown');
  });

  it('копия застряла, но на место не встала — «не знаем»', async () => {
    const name = await strandVault();
    mockFailMoveFrom = `${ROOT}${name}`;
    expect(await state()).toBe('unknown');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: подделка ФС рабочая, обычный ход цел', () => {
  it('снимок ложится и возвращается', async () => {
    expect(await snapshot()).toBe(true);
    mockFiles.delete('/doc/SQLite/airchat_local.db');
    expect(await restoreAccountVault(MNEMONIC)).toBe(true);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('local ciphertext');
  });

  it('ГРАНИЦА: на чистом устройстве возвращать нечего', async () => {
    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
  });

  it('застрявшая копия поднимается и данные из неё возвращаются', async () => {
    await strandVault();
    mockFiles.delete('/doc/SQLite/airchat_local.db');
    expect(await restoreAccountVault(MNEMONIC)).toBe(true);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('local ciphertext');
  });

  it('ГРАНИЦА: соседняя дверь честна и остаётся честной', async () => {
    // `restoreAccountVault` на отказ опроса отвечает `false`, и вызывающий
    // читает это как «не восстановилась» — свои слова у неудачи там есть.
    // Трогать её незачем, и правка ниже её не трогает.
    expect(await snapshot()).toBe(true);
    mockFailInfo.add(manifestUri());
    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('местный `exists` гасит бросок и отвечает «нет»', () => {
    const code = codeOnly(VAULT);
    const at = code.indexOf('async function exists(uri: string): Promise<boolean> {');
    expect(at).toBeGreaterThan(0);
    expect(code.slice(at, at + 160)).toContain('catch {');
    expect(code.slice(at, at + 160)).toContain('return false;');
  });

  it('у неудачи возврата слова есть, а у «копии нет» — нет: она проходит молча', () => {
    const seed = codeOnly(SEED);
    expect(seed).toContain(
      "throw new Error('Копия этого кошелька на устройстве не восстановилась. Попробуйте ещё раз.');"
    );
    // Спрашивают о копии ровно здесь. Ветка «снимка нет» законна и оттого
    // нема: профиль заводится чистым, и ошибочное «нет» ничем себя не выдаёт.
    expect(seed).toContain('restoreAccountVault(normalized)');
  });

  it('выход из кошелька уносит копию — ошибиться тут можно один раз', () => {
    expect(codeOnly(APP)).toContain('const wipe = await performLocalWalletWipe();');
    const wipe = codeOnly(
      readFileSync(join(__dirname, '..', '..', 'wallet', 'wipeLocalWallet.ts'), 'utf8')
    );
    expect(wipe).toContain('deleteAccountVault(');
  });
});

describe('ЗАКРЕПКА: ответ о копии строгий', () => {
  it('состояние отвечает тремя словами', () => {
    const code = codeOnly(VAULT);
    expect(code).toContain(
      "export type AccountVaultSnapshot = 'present' | 'absent' | 'unknown';"
    );
    expect(code).toContain(
      'export async function accountVaultSnapshotState(mnemonic: string): Promise<AccountVaultSnapshot> {'
    );
  });

  it('гасящая дверь из модуля ушла совсем', () => {
    // Оставить её значит оставить соблазн: подпись у неё удобная, а ответ
    // на «посмотреть не смогли» — неверный.
    // Только код: в пояснениях старое имя названо нарочно — там сказано,
    // чем именно она отвечала неверно.
    expect(codeOnly(VAULT)).not.toContain('hasAccountVaultSnapshot');
    expect(codeOnly(SEED)).not.toContain('hasAccountVaultSnapshot');
  });

  it('подъёмник докладывает, удалось ли ему посмотреть', () => {
    const code = codeOnly(VAULT);
    expect(code).toContain('async function restoreStrandedVault(accountId: string): Promise<boolean> {');
    const at = code.indexOf('export async function accountVaultSnapshotState');
    expect(code.slice(at, at + 600)).toContain("if (!(await restoreStrandedVault(accountId))) return 'unknown';");
  });

  it('ГРАНИЦА: исправный диск отвечает по-прежнему определённо', async () => {
    expect(await state()).toBe('absent');
    expect(await snapshot()).toBe(true);
    expect(await state()).toBe('present');
  });
});
