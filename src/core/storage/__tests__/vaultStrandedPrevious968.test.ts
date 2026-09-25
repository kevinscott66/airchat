/**
 * Копия счёта больше не пропадает вместе с именем каталога (v4.32.968).
 *
 * Дефект. Замена копии уводит прежнюю в `.previous-<счёт>-<время>` и при
 * отказе возвращает обратно — так написано и в пояснении рядом. Но возврат
 * стоял под немым `.catch(() => {})`, а выключенное питание и убитый процесс
 * никакого `catch` не ждут вовсе. Имя `.previous-…` во всём приложении не
 * читал и не убирал никто: оно встречалось ровно один раз — в строке, которая
 * его создаёт.
 *
 * Цена. Спрашивающий получает «копии нет» — и на этом всё кончается: перед
 * возвратом из мнемоники сначала спрашивают именно этим вопросом, и на «нет»
 * возврат не пробуют вовсе. То есть единственный местный слепок счёта — базы,
 * список профилей, снимки — лежит на диске целым и недостижимым. Заодно каждый
 * сорвавшийся снимок оставлял ещё один такой каталог: мусор, который не убирал
 * никто.
 *
 * Правка. Застрявшую копию поднимают перед каждым чтением; после удачного
 * снимка мусор от прежних срывов убирается; удаление копии уносит и его —
 * иначе «удалил» было бы на словах. Отказ возврата пишется в журнал.
 *
 * Границы. Файловая система поддельная, в памяти: проверяется порядок
 * действий, а не песочница iOS.
 */
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const mockSecure = new Map<string, string>();
/** Пути, переезд НА которые отказывает. */
const mockFailMoveTo = new Set<string>();
/** Переезд ОТКУДА отказывает — по началу пути. */
let mockFailMoveFrom = '';

/** Как настоящая: имена детей, включая подкаталоги. */
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

/** Каталог существует, если в нём что-то лежит: так и на устройстве. */
function mockPathExists(uri: string): boolean {
  if (mockFiles.has(uri) || mockDirs.has(uri)) return true;
  if (!uri.endsWith('/')) return false;
  for (const key of [...mockFiles.keys(), ...mockDirs]) if (key.startsWith(uri)) return true;
  return false;
}

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/doc/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: jest.fn(async (uri: string) => ({ exists: mockPathExists(uri) })),
  makeDirectoryAsync: jest.fn(async (uri: string) => { mockDirs.add(uri); }),
  readDirectoryAsync: jest.fn(async (uri: string) => mockChildren(uri)),
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
    if (mockFailMoveTo.has(to)) throw new Error(`move failed → ${to}`);
    if (mockFailMoveFrom && from.startsWith(mockFailMoveFrom)) {
      throw new Error(`move failed ${from} →`);
    }
    for (const key of [...mockFiles.keys()]) {
      if (!key.startsWith(from)) continue;
      mockFiles.set(`${to}${key.slice(from.length)}`, mockFiles.get(key)!);
      mockFiles.delete(key);
    }
    // Каталоги переезжают вместе с содержимым — иначе подделка теряет то, чем
    // эта проверка и занята: имя каталога.
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
  deleteAccountVault,
  hasAccountVaultSnapshot,
  restoreAccountVault,
  snapshotAccountVault,
} from '../accountVault';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ROOT = '/doc/airchat_account_vault_v1/';
const STATE = JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Александр' }] });

const vaultDir = (mnemonic: string): string => `${ROOT}${accountVaultIdFromMnemonic(mnemonic)}/`;
/** Имена застрявших копий счёта в корне. */
const stranded = (mnemonic: string): string[] =>
  mockChildren(ROOT).filter((n) => n.startsWith(`.previous-${accountVaultIdFromMnemonic(mnemonic)}-`));

/** Снять копию так, чтобы она легла. */
async function snapshot(mnemonic = MNEMONIC): Promise<boolean> {
  mockSecure.set(PROFILE_STATE_KEY, STATE);
  return snapshotAccountVault(mnemonic, STATE);
}

/**
 * Сорвать замену так, чтобы не вышел и возврат: оба переезда идут НА одно и то
 * же место, и отказ этого места роняет обе попытки разом.
 */
async function snapshotWithStuckReplace(): Promise<void> {
  mockFailMoveTo.add(vaultDir(MNEMONIC));
  await expect(snapshot()).resolves.toBe(false);
  mockFailMoveTo.clear();
}

/** Только код: пояснения закрепку удовлетворять не должны. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SRC = codeOnly(readFileSync(join(__dirname, '..', 'accountVault.ts'), 'utf8'));
const SEED = codeOnly(readFileSync(join(__dirname, '..', '..', 'backup', 'seedPhrase.ts'), 'utf8'));

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockSecure.clear();
  mockFailMoveTo.clear();
  mockFailMoveFrom = '';
  mockDirs.add('/doc/');
  mockDirs.add('/doc/SQLite/');
  mockFiles.set('/doc/SQLite/airchat_local.db', 'local ciphertext');
  mockFiles.set('/doc/SQLite/airchat_feed_p1.db', 'feed ciphertext');
  mockFiles.set('/doc/avatar_123.jpg', 'avatar bytes');
});

describe('копия, застрявшая под чужим именем, находится и поднимается', () => {
  it('после сорвавшейся замены копия снова числится на устройстве', async () => {
    expect(await snapshot()).toBe(true);
    await snapshotWithStuckReplace();
    // До правки здесь было `false`: копия лежала под `.previous-…`, а это имя
    // не читал никто.
    expect(await hasAccountVaultSnapshot(MNEMONIC)).toBe(true);
    expect(stranded(MNEMONIC)).toEqual([]);
  });

  it('и данные из неё возвращаются, а не теряются', async () => {
    expect(await snapshot()).toBe(true);
    await snapshotWithStuckReplace();

    for (const key of [...mockFiles.keys()]) {
      if (key.startsWith('/doc/SQLite/') || key === '/doc/avatar_123.jpg') mockFiles.delete(key);
    }
    mockSecure.delete(PROFILE_STATE_KEY);

    expect(await restoreAccountVault(MNEMONIC)).toBe(true);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('local ciphertext');
    expect(mockFiles.get('/doc/avatar_123.jpg')).toBe('avatar bytes');
  });

  it('удачный снимок убирает мусор от прежних срывов', async () => {
    expect(await snapshot()).toBe(true);
    await snapshotWithStuckReplace();
    // Подняли не читая — просто снимаем заново поверх.
    expect(await snapshot()).toBe(true);
    expect(stranded(MNEMONIC)).toEqual([]);
  });

  it('удаление копии уносит и застрявшую — иначе «удалил» было бы на словах', async () => {
    expect(await snapshot()).toBe(true);
    await snapshotWithStuckReplace();
    await deleteAccountVault(MNEMONIC);
    expect(stranded(MNEMONIC)).toEqual([]);
    expect(await hasAccountVaultSnapshot(MNEMONIC)).toBe(false);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Подъёмник не должен ни выдумывать копию там, где её не было, ни подбирать
 * чужую, ни мешать обычному ходу.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный ход не изменился', () => {
  it('снимок и возврат работают как прежде', async () => {
    expect(await snapshot()).toBe(true);
    for (const key of [...mockFiles.keys()]) {
      if (key.startsWith('/doc/SQLite/')) mockFiles.delete(key);
    }
    expect(await restoreAccountVault(MNEMONIC)).toBe(true);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('local ciphertext');
  });

  it('удачный снимок не оставляет отодвинутых копий вовсе', async () => {
    expect(await snapshot()).toBe(true);
    expect(await snapshot()).toBe(true);
    expect(stranded(MNEMONIC)).toEqual([]);
  });

  it('ГРАНИЦА: копии не было — «нет» так и остаётся', async () => {
    expect(await hasAccountVaultSnapshot(MNEMONIC)).toBe(false);
    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
  });

  it('ГРАНИЦА: чужой счёт застрявшую копию не подбирает', async () => {
    expect(await snapshot()).toBe(true);
    await snapshotWithStuckReplace();
    // Подъём идёт по имени счёта: чужая застрявшая копия своей не становится
    // ни до правки, ни после.
    expect(await hasAccountVaultSnapshot(OTHER)).toBe(false);
  });

  it('ГРАНИЦА: откат удался — прежняя копия на месте, мусора нет', async () => {
    expect(await snapshot()).toBe(true);
    const before = mockFiles.get(`${vaultDir(MNEMONIC)}manifest.json`);
    expect(before).toBeTruthy();

    // Отказывает только переезд наготовленного каталога; возврат отодвинутой
    // копии проходит — так было задумано с самого начала.
    mockFailMoveFrom = `${ROOT}.staging-`;
    expect(await snapshot()).toBe(false);
    mockFailMoveFrom = '';

    expect(mockFiles.get(`${vaultDir(MNEMONIC)}manifest.json`)).toBe(before);
    expect(stranded(MNEMONIC)).toEqual([]);
    expect(await hasAccountVaultSnapshot(MNEMONIC)).toBe(true);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Байты никуда не девались — терялось только имя. И спрашивают об этом имени
 * ровно один раз: на «копии нет» возврат из мнемоники не пробуют вовсе.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: терялось имя, а не данные', () => {
  it('после срыва содержимое копии лежит на диске целым', async () => {
    expect(await snapshot()).toBe(true);
    mockFailMoveTo.add(vaultDir(MNEMONIC));
    await expect(snapshot()).resolves.toBe(false);
    mockFailMoveTo.clear();
    // Где-то под корнем хранилища список файлов копии есть — вопрос только в
    // том, найдёт ли его спрашивающий.
    const anyManifest = [...mockFiles.keys()].some(
      (k) => k.startsWith(ROOT) && k.endsWith('manifest.json')
    );
    expect(anyManifest).toBe(true);
  });

  it('возврат из мнемоники сначала спрашивает «копия есть?» и на «нет» не пробует', () => {
    expect(SEED).toContain(
      'if ((await hasAccountVaultSnapshot(normalized)) && !(await restoreAccountVault(normalized)))'
    );
  });
});

describe('форма исходников: застрявшую копию ищут, поднимают и убирают', () => {
  it('у отодвинутого имени есть и создатель, и подъёмник', () => {
    expect(SRC).toContain('function previousVaultPrefix(accountId: string): string {');
    expect(SRC).toContain('async function strandedVaultNames(root: string, accountId: string): Promise<string[]> {');
    expect(SRC).toContain('async function restoreStrandedVault(accountId: string): Promise<void> {');
  });

  it('все три читателя копии поднимают её перед чтением', () => {
    expect(SRC.split('await restoreStrandedVault(accountId);').length - 1).toBe(3);
  });

  it('отказ возврата больше не молчит', () => {
    expect(SRC).toContain("log.error('account_vault_previous_rollback_failed'");
    expect(SRC).not.toContain('await FileSystem.moveAsync({ from: previousDir, to: finalDir }).catch(() => {});');
  });
});
