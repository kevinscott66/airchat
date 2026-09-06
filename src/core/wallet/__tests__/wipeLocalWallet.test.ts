/**
 * Сброс локального кошелька (v4.32.353).
 *
 * Функция стоит за кнопкой «Выйти и удалить данные на устройстве» — самым
 * сильным обещанием приложения. Проверяются два свойства, которых у неё не
 * было: сброс доходит до конца, что бы ни упало по дороге, и результат
 * подтверждается чтением, а не тем фактом, что удаление было вызвано.
 *
 * Списки секретных ключей берутся из настоящих модулей (jest.requireActual), а
 * не переписываются здесь: тест должен ловить расхождение, а не повторять его.
 */

const mockStore = new Map<string, string>();
/** Сколько ближайших удалений данного ключа провалить. */
const mockDeleteFailures = new Map<string, number>();
/** Сколько ближайших чтений данного ключа провалить. */
const mockReadFailures = new Map<string, number>();
/** Порядок вызовов — для проверок «раньше/позже». */
const mockCalls: string[] = [];
/** Шаги, которые должны бросить исключение. */
const mockThrowingSteps = new Set<string>();

function mockRawDelete(key: string): void {
  const left = mockDeleteFailures.get(key) ?? 0;
  if (left > 0) {
    mockDeleteFailures.set(key, left - 1);
    throw new Error('keystore locked');
  }
  mockStore.delete(key);
}

/** Мок шага: пишет себя в журнал вызовов и падает, если так задано тестом. */
function mockStep(name: string): void {
  mockCalls.push(name);
  if (mockThrowingSteps.has(name)) throw new Error(`${name} failed`);
}

jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: async (key: string): Promise<string | null> => {
    const left = mockReadFailures.get(key) ?? 0;
    if (left > 0) {
      mockReadFailures.set(key, left - 1);
      throw new Error('keystore busy');
    }
    return mockStore.has(key) ? mockStore.get(key)! : null;
  },
  deleteItemAsync: async (key: string): Promise<void> => {
    mockCalls.push(`delete:${key}`);
    mockRawDelete(key);
  },
}));

jest.mock('../../backup/seedPhrase', () => ({
  ...jest.requireActual('../../backup/seedPhrase'),
  getStoredMnemonic: async (): Promise<string | null> =>
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  // Настоящая функция глотает ошибку по каждому ключу отдельно — мок повторяет
  // ровно это поведение, иначе проверка «пережившие секреты» проверяла бы мок.
  wipeMnemonicAndSessionFlags: async (): Promise<void> => {
    mockStep('mnemonic');
    for (const key of [
      ...jest.requireActual('../../backup/seedPhrase').SEED_SECURE_KEYS,
      ...jest.requireActual('../../backup/seedPhrase').SESSION_SECURE_KEYS,
    ]) {
      try { mockRawDelete(key); } catch { /* как в оригинале */ }
    }
  },
}));

jest.mock('../../crypto/keyManager', () => ({
  ...jest.requireActual('../../crypto/keyManager'),
  deleteKeyPairFromStore: async (): Promise<void> => {
    mockStep('keypair');
    for (const key of jest.requireActual('../../crypto/keyManager').KEYPAIR_SECURE_KEYS) {
      try { mockRawDelete(key); } catch { /* как в оригинале */ }
    }
  },
}));

jest.mock('../../security/authGuard', () => ({
  ...jest.requireActual('../../security/authGuard'),
  authGuard: {
    clearAllAuthData: async (): Promise<void> => {
      mockStep('auth_data');
      for (const key of jest.requireActual('../../security/authGuard').AUTH_SECURE_KEYS) {
        try { mockRawDelete(key); } catch { /* как в оригинале */ }
      }
    },
  },
}));

jest.mock('../../storage/localEncryption', () => ({
  ...jest.requireActual('../../storage/localEncryption'),
  clearDekMemory: () => mockStep('dek_memory'),
}));

jest.mock('../../logger', () => ({
  log: {
    info: (msg: string, meta?: unknown) => mockCalls.push(`log:${msg}:${JSON.stringify(meta ?? null)}`),
    warn: (msg: string, meta?: unknown) => mockCalls.push(`log:${msg}:${JSON.stringify(meta ?? null)}`),
    debug: () => {},
    error: () => {},
  },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getProfileIds: () => {
      mockStep('collect_profile_ids');
      return [1, 4];
    },
    clearForWalletWipe: async () => {
      mockStep('profiles');
      try { mockRawDelete(jest.requireActual('../../identity/profileStateKey').PROFILE_STATE_KEY); } catch { /* как в оригинале */ }
    },
  },
}));

jest.mock('../../storage/dialogBackup', () => ({
  cancelScheduledDialogBackup: () => mockStep('cancel_dialog_backup'),
  deleteAllDialogBackups: async () => mockStep('dialog_backups'),
}));
jest.mock('../../storage/accountVault', () => ({
  deleteAccountVault: async () => mockStep('account_vault'),
}));
jest.mock('../../sync/syncApi', () => ({
  ...jest.requireActual('../../sync/syncApi'),
  clearSyncDeviceCredentials: async () => mockStep('sync_device_credentials'),
}));

jest.mock('../../storage/local', () => ({
  closeLocalDatabase: async () => mockStep('local_db_close'),
  wipeLocalDatabase: async () => mockStep('local_db'),
}));
jest.mock('../../storage/feedStorage', () => ({
  deleteAllFeedDbs: async (ids: number[]) => {
    mockCalls.push(`feed_dbs:${ids.join('+')}`);
    mockStep('feed_dbs');
  },
}));
jest.mock('../../social/messaging', () => ({ disposeMessagingService: () => mockStep('messaging_service') }));
jest.mock('../../social/callService', () => ({ disposeCallService: () => mockStep('call_service') }));
jest.mock('../../social/feedService', () => ({
  stopFeedInboxListener: () => mockStep('feed_inbox_listener'),
  closeFeedStorage: async () => mockStep('feed_storage_close'),
}));
jest.mock('../../social/presenceService', () => ({ stopPresenceBroadcast: async () => mockStep('presence_broadcast') }));
jest.mock('../../social/storyService', () => ({ stopStoryInboxListener: () => mockStep('story_inbox_listener') }));
jest.mock('../../social/liveLocationService', () => ({ stopAllLiveLocSessions: () => mockStep('live_location') }));
jest.mock('../../social/scheduledMessages', () => ({ stopScheduler: () => mockStep('scheduler') }));
jest.mock('../../../notifications/pushNotifications', () => ({ disposePushNotificationService: async () => mockStep('push_service') }));
jest.mock('../../security/rateLimiter', () => ({ rateLimiter: { resetForProfileSwitch: async () => mockStep('rate_limiter') } }));
jest.mock('../../media/cacheFiles', () => ({ purgeSensitiveCache: async () => mockStep('media_cache') }));
jest.mock('../../media/avatarFiles', () => ({ sweepAvatarFiles: async () => mockStep('avatars') }));
jest.mock('../../security/clipboardSecret', () => ({ clearSecretClipboardNow: async () => mockStep('clipboard') }));
jest.mock('../../transport/ipfs/node', () => ({ resetIpfsClient: () => mockStep('ipfs_client') }));

import { SEED_SECURE_KEYS } from '../../backup/seedPhrase';
import { SESSION_SECURE_KEYS } from '../../backup/seedPhrase';
import { KEYPAIR_SECURE_KEYS } from '../../crypto/keyManager';
import { AUTH_SECURE_KEYS } from '../../security/authGuard';
import { SYNC_DEVICE_SECURE_KEYS } from '../../sync/syncApi';
import { DEK_CANARY_KEY, DEK_KEY } from '../../storage/localEncryption';
import { PROFILE_STATE_KEY } from '../../identity/profileStateKey';
import { performLocalWalletWipe } from '../wipeLocalWallet';

const FCM_TOKEN_KEY = 'airchat_fcm_token_v1';
const SEED_KEY = SEED_SECURE_KEYS[0];
const ALL_SECRETS = [
  ...SEED_SECURE_KEYS,
  ...SESSION_SECURE_KEYS,
  ...KEYPAIR_SECURE_KEYS,
  ...AUTH_SECURE_KEYS,
  ...SYNC_DEVICE_SECURE_KEYS,
  PROFILE_STATE_KEY,
  DEK_KEY,
  DEK_CANARY_KEY,
  FCM_TOKEN_KEY,
];

/*
 * v4.32.614: пять шагов сброса грузят свой модуль через `await import(...)` —
 * так разорваны циклические зависимости, — и под jest падали ВСЕ, потому что
 * `import()` оставался нетронутым и бросал ERR_VM_DYNAMIC_IMPORT_CALLBACK_-
 * MISSING_FLAG. Здесь стоял список этих пяти имён, и каждая проверка итога
 * несла его в ожидании.
 *
 * Цена была не в кривом списке. Пять шагов — среди них account_vault, который
 * убирает копию аккаунта с сервера, — не выполнялись в тестах ни разу, и
 * сломать их было нечем: любая поломка внутри давала то же самое имя в
 * failedSteps. Плагин в babel.config.js (env.test) чинит `import()`, шаги
 * пошли по-настоящему, и теперь пустой failedSteps — настоящий пустой.
 */

/**
 * Где шаг оказался в журнале: либо своим именем, либо записью о падении —
 * упавший шаг тоже занимает своё место во времени.
 */
const posOf = (name: string): number =>
  mockCalls.findIndex((c) => c === name || c.startsWith(`log:wallet_wipe_step_failed:{"step":"${name}"`));

/**
 * То же самое, но для проверок порядка — и с обязательным условием, что шаг
 * вообще случился (v4.32.614).
 *
 * Тут была вакуумная проверка: «копия переписки пишется ДО удаления базы»
 * сравнивала `posOf('dialog_backup_export')` с `posOf('local_db')`. Шага с
 * таким именем в сбросе нет и никогда не было, `posOf` отдавал -1, а -1
 * меньше любого места в журнале — проверка была зелёной при любом порядке и
 * даже при полностью выключённом сбросе. Опечатка в имени шага стоила бы
 * ровно столько же и осталась бы незамеченной.
 */
const orderOf = (name: string): number => {
  const i = posOf(name);
  if (i < 0) throw new Error(`шага «${name}» в журнале сброса нет — проверка порядка бессмысленна`);
  return i;
};

beforeEach(() => {
  mockStore.clear();
  mockDeleteFailures.clear();
  mockReadFailures.clear();
  mockThrowingSteps.clear();
  mockCalls.length = 0;
  // Устройство «в рабочем состоянии»: все секреты на месте.
  for (const key of ALL_SECRETS) mockStore.set(key, 'secret');
});

describe('performLocalWalletWipe', () => {
  it('стирает все секреты, несмотря на упавшие по дороге шаги', async () => {
    const res = await performLocalWalletWipe();

    expect(res).toEqual({ ok: true, failedSteps: [], survivors: [] });
    expect([...mockStore.keys()]).toEqual([]);
  });

  it('доходит до каждого шага, а не только до удаления ключей', async () => {
    await performLocalWalletWipe();

    for (const name of [
      'cancel_dialog_backup', 'auth_data', 'feed_inbox_listener', 'presence_broadcast',
      'push_service', 'rate_limiter', 'story_inbox_listener', 'live_location', 'scheduler',
      'ipfs_client', 'messaging_service', 'call_service', 'feed_storage_close', 'local_db_close',
      'dialog_backups', 'account_vault', 'sync_device_credentials', 'dek_memory',
      'collect_profile_ids', 'profiles', 'mnemonic', 'keypair', 'local_db', 'feed_dbs',
      'media_cache', 'avatars', 'clipboard',
    ]) {
      expect([name, posOf(name) >= 0]).toEqual([name, true]);
    }
  });

  it('сбой раннего шага НЕ отменяет удаление seed, ключей и базы', async () => {
    // Ровно та регрессия, ради которой раунд и делался: до правки первый же
    // await без try уводил выполнение в catch вызывающего, и пользователь
    // оставался с нетронутой сид-фразой при сообщении «выход выполнен».
    mockThrowingSteps.add('auth_data');

    const res = await performLocalWalletWipe();

    expect(mockCalls).toEqual(expect.arrayContaining(['mnemonic', 'keypair', 'local_db']));
    expect(res.failedSteps).toEqual(['auth_data']);
    // Ключи пароля остались (шаг упал), но сброс их добил проверкой.
    expect(res).toMatchObject({ ok: true, survivors: [] });
  });

  it('сбой в середине не отменяет ни один из последующих шагов', async () => {
    mockThrowingSteps.add('profiles');

    const res = await performLocalWalletWipe();

    expect(res.failedSteps).toEqual(['profiles']);
    expect(mockCalls).toEqual(expect.arrayContaining(['mnemonic', 'keypair', 'local_db', 'clipboard']));
    expect(res.ok).toBe(true);
  });

  it('базы закрываются ДО удаления их файлов', async () => {
    // Удалять файл открытой SQLite — значит оставить рядом -wal и -shm с
    // теми же расшифрованными строками, которые и просили стереть.
    await performLocalWalletWipe();

    expect(orderOf('local_db_close')).toBeLessThan(orderOf('local_db'));
    expect(orderOf('feed_storage_close')).toBeLessThan(orderOf('feed_dbs'));
  });

  it('облачная копия аккаунта удаляется ДО стирания сид-фразы', async () => {
    // Шаг account_vault читает сид-фразу (getStoredMnemonic) и только ею
    // может назвать серверу, какую копию убрать. После wipeMnemonicAndSession-
    // Flags называть нечем: локально всё чисто, а копия аккаунта остаётся
    // лежать на сервере — то есть «удалить данные» их не удаляет.
    await performLocalWalletWipe();

    expect(orderOf('account_vault')).toBeLessThan(orderOf('mnemonic'));
  });

  it('номера профилей собираются до их очистки и уходят в удаление лент', async () => {
    // После clearForWalletWipe список пуст, а базы лент названы по номеру:
    // собрать их позже — значит не удалить ни одной.
    await performLocalWalletWipe();

    expect(orderOf('collect_profile_ids')).toBeLessThan(orderOf('profiles'));
    expect(mockCalls).toContain('feed_dbs:1+4');
  });

  it('канарейка ключа уходит вместе с ключом и раньше него', async () => {
    // Регрессия v4.32.603. Канарейку не удалял никто: после «выйти и удалить
    // данные» на устройстве оставалась запись «данные зашифрованы ключом,
    // которого нет», и следующий запуск отказывался открывать приложение
    // (`local data key unavailable: key_lost_data_present`). Починить это
    // изнутри было нечем — до входа дело просто не доходило.
    const res = await performLocalWalletWipe();

    expect(mockStore.has(DEK_CANARY_KEY)).toBe(false);
    expect(res.survivors).toEqual([]);
    // Порядок: из двух исходов частичного сбоя ключ без канарейки запуску не
    // мешает, а канарейка без ключа делает его невозможным.
    expect(mockCalls.indexOf(`delete:${DEK_CANARY_KEY}`)).toBeGreaterThanOrEqual(0);
    expect(mockCalls.indexOf(`delete:${DEK_CANARY_KEY}`)).toBeLessThan(
      mockCalls.indexOf(`delete:${DEK_KEY}`)
    );
  });

  it('пережившая канарейка — это ok:false', async () => {
    // Секретом она не является, но оставшись одна, стоит дороже секрета:
    // приложение после неё не запускается вовсе. Молчать об этом нельзя.
    mockDeleteFailures.set(DEK_CANARY_KEY, 99);

    const res = await performLocalWalletWipe();

    expect(res.ok).toBe(false);
    expect(res.survivors).toEqual([DEK_CANARY_KEY]);
  });

  it('переживший секрет — это ok:false, а не исключение', async () => {
    // Устройство заблокировано, SecureStore не отдаёт ключ. Раньше об этом не
    // узнавал никто: удаление глотает свою ошибку, и сброс отчитывался успехом.
    mockDeleteFailures.set(SEED_KEY, 99);

    const res = await performLocalWalletWipe();

    expect(res.ok).toBe(false);
    expect(res.survivors).toEqual([SEED_KEY]);
    expect(mockStore.has(SEED_KEY)).toBe(true);
  });

  it('разовый сбой удаления добивается повторной попыткой', async () => {
    // Первый заход падает, второй (в проверке) проходит — типичный случай
    // «keystore был занят». Ради него проверка и делает второй заход.
    mockDeleteFailures.set(SEED_KEY, 1);

    const res = await performLocalWalletWipe();

    expect(res).toEqual({ ok: true, failedSteps: [], survivors: [] });
    expect(mockStore.has(SEED_KEY)).toBe(false);
  });

  it('нечитаемый ключ считается выжившим, а не удалённым', async () => {
    // Из двух неверных ответов «возможно, осталось» безопаснее, чем «точно
    // удалено»: на втором пользователь отдаёт устройство.
    mockReadFailures.set(DEK_KEY, 99);

    const res = await performLocalWalletWipe();

    expect(res.ok).toBe(false);
    expect(res.survivors).toEqual([DEK_KEY]);
  });

  it('проверяются все секреты, а не только seed', async () => {
    for (const key of ALL_SECRETS) mockDeleteFailures.set(key, 99);

    const res = await performLocalWalletWipe();

    expect(res.survivors.sort()).toEqual([...ALL_SECRETS].sort());
  });

  it('сбой уборки файлов не делает сброс неуспешным', async () => {
    // Кэш, аватары и буфер обмена — важно, но это не секреты в SecureStore:
    // ok отвечает именно за них, иначе признак обесценится.
    mockThrowingSteps.add('media_cache');
    mockThrowingSteps.add('avatars');
    mockThrowingSteps.add('clipboard');

    const res = await performLocalWalletWipe();

    expect(res.ok).toBe(true);
    expect(res.failedSteps).toEqual(['media_cache', 'avatars', 'clipboard']);
  });

  it('итог попадает в журнал целиком', async () => {
    mockDeleteFailures.set(SEED_KEY, 99);
    mockThrowingSteps.add('avatars');

    const res = await performLocalWalletWipe();

    expect(mockCalls).toContain(`log:wallet_wipe_done:${JSON.stringify(res)}`);
    expect(mockCalls.some((c) => c.startsWith('log:wallet_wipe_secrets_survived:'))).toBe(true);
  });

  it('списки секретных ключей не пересекаются и не пусты', () => {
    // Иначе «проверили всё» означало бы «проверили один и тот же ключ дважды».
    expect(ALL_SECRETS.length).toBeGreaterThanOrEqual(9);
    expect(new Set(ALL_SECRETS).size).toBe(ALL_SECRETS.length);
  });
});
