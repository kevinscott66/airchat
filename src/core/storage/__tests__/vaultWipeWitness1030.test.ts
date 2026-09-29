/**
 * v4.32.1030 — «копию счёта стёрли» говорилось, не посмотрев на диск.
 *
 * Дефект. `deleteAccountVault` сносит каталог копии, а затем обходит
 * застрявшие под `.previous-…` — те, что остаются от прерванной замены. Обход
 * этот молчал дважды. Список имён брался у `strandedVaultNames`, а тот на
 * отказ чтения каталога отвечает пустым списком — «застрявших нет». И каждое
 * удаление стояло под немым `.catch(() => {})`. Функция после обоих отказов
 * возвращалась как ни в чём не бывало.
 *
 * Цена. Копия счёта — это базы переписки, список профилей и снимки, и
 * открывается она одной секретной фразой: каталог назван её отпечатком, а
 * внутри лежит ключ, выведенный из неё же. Стирание кошелька затем и делают,
 * чтобы этого на устройстве не осталось, — телефон отдают и продают. Шаг
 * `account_vault` при отказе обхода записывался удачным, в `leftBehind` не
 * попадал ничего, и экран говорил о полном стирании. Хуже того, остаток не
 * лежит мёртвым грузом: `accountVaultSnapshotState` перед каждым чтением зовёт
 * подъёмник застрявших копий — тот находит `.previous-…` и возвращает её на
 * законное место. Стёртый счёт предлагался к восстановлению.
 *
 * Свидетеля у шага не было: `FILE_STEPS` в `wipeLocalWallet` перечитывает
 * кэш медиа, аватары и копии историй — копии счёта среди них нет.
 *
 * Правка. Уборка отчитывается перечитыванием диска
 * (`survivingAccountVaultFiles`), и оставшееся называется броском — его ловит
 * `erase` и кладёт шаг в `failedSteps` и `leftBehind`. Отказ самой проверки —
 * тоже «осталось»: неизвестность здесь не читается как пустота.
 *
 * Границы. Файловая система поддельная, в памяти: проверяется порядок
 * действий и честность ответа, а не песочница iOS.
 */
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const mockSecure = new Map<string, string>();
/** Пути, чтение каталога по которым отказывает: занятый том, сбой ФС. */
const mockFailReadDir = new Set<string>();
/** Пути, удаление которых отказывает. Сверяется по началу пути. */
const mockFailDeleteFrom = new Set<string>();
/** Пути, опрос существования которых отказывает. */
const mockFailInfo = new Set<string>();

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
    for (const bad of mockFailDeleteFrom) if (uri.startsWith(bad)) throw new Error(`delete failed ${uri}`);
    const prefix = uri.endsWith('/') ? uri : `${uri}/`;
    const hit = (key: string): boolean => key === uri || key.startsWith(prefix);
    for (const key of [...mockFiles.keys()]) if (hit(key)) mockFiles.delete(key);
    for (const key of [...mockDirs]) if (hit(key)) mockDirs.delete(key);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
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
  accountVaultSnapshotState,
  deleteAccountVault,
  snapshotAccountVault,
} from '../accountVault';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ROOT = '/doc/airchat_account_vault_v1/';
const STATE = JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Александр' }] });

const accountId = (m = MNEMONIC): string => accountVaultIdFromMnemonic(m);
const vaultDir = (m = MNEMONIC): string => `${ROOT}${accountId(m)}/`;
/** Имена застрявших копий счёта в корне. */
const stranded = (m = MNEMONIC): string[] =>
  mockChildren(ROOT).filter((n) => n.startsWith(`.previous-${accountId(m)}-`));

/** Снять копию так, чтобы она легла. */
async function snapshot(): Promise<boolean> {
  mockSecure.set(PROFILE_STATE_KEY, STATE);
  return snapshotAccountVault(MNEMONIC, STATE);
}

/**
 * Оставить на диске застрявшую копию — такую, какой её оставляет убитый в
 * середине замены процесс: каталог `.previous-…` есть, свежая копия на месте.
 */
async function leaveStranded(): Promise<string> {
  await expect(snapshot()).resolves.toBe(true);
  const name = `.previous-${accountId()}-1700000000000`;
  mockDirs.add(`${ROOT}${name}/`);
  mockFiles.set(`${ROOT}${name}/manifest.json`, '{}');
  return name;
}

/** Только код: пояснения закрепку удовлетворять не должны. */
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
const WIPE = readFileSync(join(__dirname, '..', '..', 'wallet', 'wipeLocalWallet.ts'), 'utf8');

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockSecure.clear();
  mockFailReadDir.clear();
  mockFailDeleteFrom.clear();
  mockFailInfo.clear();
});

describe('уборка копии счёта отвечает за то, что сделала', () => {
  it('не прочитался корень — уборка признаёт, что не знает, что осталось', async () => {
    await leaveStranded();
    mockFailReadDir.add(ROOT);
    // Раньше отказ чтения отвечал «застрявших нет», и шаг стирания записывался
    // удачным. Копия при этом лежит на диске целой.
    await expect(deleteAccountVault(MNEMONIC)).rejects.toThrow();
  });

  it('не удалилась застрявшая копия — об этом сказано, а не умолчано', async () => {
    const name = await leaveStranded();
    mockFailDeleteFrom.add(`${ROOT}${name}`);
    await expect(deleteAccountVault(MNEMONIC)).rejects.toThrow();
    // И она действительно осталась: это не придирка к форме ответа.
    expect(stranded()).toContain(name);
  });

});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычное стирание проходит молча', () => {
  it('не удалился сам каталог копии — бросок, и так было и до правки', async () => {
    // Своя дверь у главного каталога была честной с самого начала: бросок
    // `deleteAsync` уходил наружу. Держим это здесь, чтобы правка ниже не
    // приглушила заодно и его.
    await expect(snapshot()).resolves.toBe(true);
    mockFailDeleteFrom.add(vaultDir());
    await expect(deleteAccountVault(MNEMONIC)).rejects.toThrow();
  });

  it('копия и застрявшие уносятся, наружу ничего не бросается', async () => {
    const name = await leaveStranded();
    await expect(deleteAccountVault(MNEMONIC)).resolves.toBeUndefined();
    expect(mockPathExists(vaultDir())).toBe(false);
    expect(stranded()).not.toContain(name);
  });

  it('на чистом устройстве стирать нечего и жаловаться не на что', async () => {
    await expect(deleteAccountVault(MNEMONIC)).resolves.toBeUndefined();
  });

  it('чужие копии не трогаются и своей уборке не мешают', async () => {
    await leaveStranded();
    const alien = `${ROOT}.previous-ffff0000-1700000000001/`;
    mockDirs.add(alien);
    mockFiles.set(`${alien}manifest.json`, '{}');
    await expect(deleteAccountVault(MNEMONIC)).resolves.toBeUndefined();
    expect(mockPathExists(alien)).toBe(true);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('застрявшая копия не мусор: её поднимают и предлагают восстановить', async () => {
    const name = await leaveStranded();
    // Своей копии нет, застрявшая есть — подъёмник вернёт её на место, и
    // вопрос «есть ли копия?» ответит «да». Ровно тот счёт, что велели стереть.
    await expect(deleteAccountVault(MNEMONIC)).resolves.toBeUndefined();
    mockDirs.add(`${ROOT}${name}/`);
    mockFiles.set(`${ROOT}${name}/manifest.json`, '{}');
    // v4.32.1031: ответ стал трёхсловным. Повод прежний: поднятая копия
    // числится на устройстве, и её предложат восстановить.
    expect(await accountVaultSnapshotState(MNEMONIC)).toBe('present');
  });

  it('свидетеля у шага нет: копия счёта не перечитывается в конце стирания', () => {
    const wipe = codeOnly(WIPE);
    expect(wipe).toContain("{ name: 'media_cache'");
    expect(wipe).toContain("{ name: 'avatars'");
    expect(wipe).toContain("{ name: 'story_albums'");
    // Если копию счёта однажды добавят в FILE_STEPS, эта проверка упадёт и
    // потребует переписать постановку, а не подкрутить ожидание.
    expect(wipe).not.toContain("{ name: 'account_vault_files'");
  });

  it('отказ шага и правда доходит до человека: erase кладёт его в leftBehind', () => {
    const wipe = codeOnly(WIPE);
    expect(wipe).toContain('const erase = (name: string, fn: () => unknown): Promise<void> => step(name, fn, failed, leftBehind);');
    expect(wipe).toContain("await erase('account_vault', async () => {");
  });
});

describe('ЗАКРЕПКА: уборка смотрит на диск, а не на собственную уверенность', () => {
  it('немого гасителя на удалении застрявших не осталось', () => {
    const code = codeOnly(VAULT);
    const at = code.indexOf('export async function deleteAccountVault(mnemonic: string): Promise<void> {');
    expect(at).toBeGreaterThan(0);
    const body = code.slice(at, at + 1200);
    expect(body).not.toContain('.catch(() => {})');
  });

  it('уборка отчитывается перечитыванием', () => {
    const code = codeOnly(VAULT);
    expect(code).toContain('export async function survivingAccountVaultFiles(mnemonic: string): Promise<string[]> {');
    const at = code.indexOf('export async function deleteAccountVault(mnemonic: string): Promise<void> {');
    expect(code.slice(at, at + 1200)).toContain('await survivingAccountVaultFiles(mnemonic)');
  });

  it('свидетель не гасит отказ опроса: неизвестность — не пустота', async () => {
    const { survivingAccountVaultFiles } = await import('../accountVault');
    await leaveStranded();
    mockFailInfo.add(vaultDir());
    await expect(survivingAccountVaultFiles(MNEMONIC)).rejects.toThrow();
  });
});
