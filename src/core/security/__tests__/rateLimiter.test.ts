/**
 * Блок-лист: шифртекст в kv и перенос со старых имён ключа (v4.32.306).
 *
 * Список публичных ключей лежал открытым текстом в базе, где имя контакта
 * зашифровано с v4.32.286, а заглушённые авторы ленты — с v4.32.293. Здесь
 * зафиксировано и это, и главное правило переноса: старую запись стираем
 * только тогда, когда новая действительно легла (v4.32.293) — иначе
 * разблокируются все разом и безвозвратно.
 *
 * Номер профиля здесь всегда 1: RateLimiter берёт его динамическим import, а
 * тот в jest не работает (нужен --experimental-vm-modules), и currentPid
 * уходит в свой запасной путь. Разделение блок-листов по профилям проверяется
 * на именах ключей — storage/__tests__/kvKeys.test.ts.
 */
jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  // Шифрование подменено обратимым префиксом — см. identity/__tests__.
  const PREFIX = 'enc2:';
  let writesFail = false;
  const kvSetSecret = jest.fn(async (k: string, v: string) => {
    if (writesFail) return false;
    kv[k] = PREFIX + v;
    return true;
  });
  const kvGetSecret = jest.fn(async (k: string) => {
    const stored = kv[k];
    if (stored == null) return null;
    return stored.startsWith(PREFIX) ? stored.slice(PREFIX.length) : stored;
  });
  return {
    __kv: kv,
    __prefix: PREFIX,
    __failWrites: (on: boolean) => { writesFail = on; },
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvGetSecret,
    kvSetSecret,
    kvGetSecretUpgrading: jest.fn(async (k: string) => {
      const stored = kv[k];
      if (stored == null) return null;
      if (stored.startsWith(PREFIX)) return stored.slice(PREFIX.length);
      await kvSetSecret(k, stored);
      return stored;
    }),
    notifyChatStorageChanged: jest.fn(),
  };
});

// keyManager тянет нативное хранилище ключей; здесь нужен только хеш.
jest.mock('../../crypto/keyManager', () => ({
  publicKeyHash4: () => new Uint8Array([1, 2, 3, 4]),
}));

let mockActiveProfile: { id: number } | null = { id: 1 };
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => mockActiveProfile },
}));

import { RateLimiter } from '../rateLimiter';

type MockLocal = {
  __kv: Record<string, string>;
  __prefix: string;
  __failWrites: (on: boolean) => void;
  kvGetSecretUpgrading: jest.Mock;
};

const mockLocal = jest.requireMock('../../storage/local') as MockLocal;

const KEY = 'p1:airchat_blocked_peer_pub_b64';
const PEER = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);

/** Как оно лежит на диске после шифрования. */
function stored(list: unknown): string {
  return `${mockLocal.__prefix}${JSON.stringify(list)}`;
}

/** Свежий лимитер с уже дочитанным списком. */
async function loaded(): Promise<RateLimiter> {
  const rl = new RateLimiter();
  await rl.whenReady();
  return rl;
}

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockLocal.__failWrites(false);
  mockActiveProfile = { id: 1 };
});

describe('блок-лист не лежит открытым текстом', () => {
  it('блокировка пишет шифртекст', async () => {
    const rl = await loaded();
    await rl.blockContact(PEER);
    expect(mockLocal.__kv[KEY].startsWith(mockLocal.__prefix)).toBe(true);
    expect(await rl.getBlockedPubKeys()).toEqual([PEER]);
  });

  it('разблокировка тоже — пустой список не остаётся открытым', async () => {
    const rl = await loaded();
    await rl.blockContact(PEER);
    await rl.unblockContact(PEER);
    expect(mockLocal.__kv[KEY].startsWith(mockLocal.__prefix)).toBe(true);
    expect(await rl.getBlockedPubKeys()).toEqual([]);
  });

  it('записанный открытым текстом список дошифровывается при чтении', async () => {
    mockLocal.__kv[KEY] = JSON.stringify([PEER]);
    const rl = await loaded();
    expect(rl.isBlocked(PEER)).toBe(true);
    expect(mockLocal.__kv[KEY]).toBe(`${mockLocal.__prefix}${JSON.stringify([PEER])}`);
  });

  it('блокировка переживает перезапуск', async () => {
    const first = await loaded();
    await first.blockContact(PEER);
    const second = await loaded();
    expect(second.isBlocked(PEER)).toBe(true);
    expect(second.isBlocked(OTHER)).toBe(false);
  });
});

describe('перенос со старых имён ключа', () => {
  const SUFFIX_KEY = 'airchat_blocked_peer_pub_b64_p1';
  const GLOBAL_KEY = 'airchat_blocked_peer_pub_b64';

  /**
   * Уборка старых ключей делается один раз за ЗАПУСК (модульный набор
   * `legacyBlockedSwept`), поэтому каждый такой случай — со своим реестром
   * модулей. Без изоляции второй тест проходил бы просто потому, что первый
   * уже отметил уборку сделанной.
   */
  async function withFreshModules(
    body: (local: MockLocal, rl: RateLimiter) => Promise<void>,
    prepare: (local: MockLocal) => void
  ): Promise<void> {
    await jest.isolateModulesAsync(async () => {
      const local = jest.requireMock('../../storage/local') as MockLocal;
      prepare(local);
      // Именно require: динамический import в jest не работает (см. шапку).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../rateLimiter') as typeof import('../rateLimiter');
      const rl = new mod.RateLimiter();
      await rl.resetForProfileSwitch();
      await body(local, rl);
    });
  }

  it('список со старым именем переезжает шифртекстом, старый ключ убирается', async () => {
    await withFreshModules(
      async (local, rl) => {
        expect(rl.isBlocked(PEER)).toBe(true);
        expect(local.__kv[SUFFIX_KEY]).toBeUndefined();
        expect(local.__kv[KEY].startsWith(local.__prefix)).toBe(true);
      },
      (local) => { local.__kv[SUFFIX_KEY] = JSON.stringify([PEER]); }
    );
  });

  it('не зашифровалось — старый ключ остаётся, а список всё равно действует', async () => {
    // Стереть исходную запись, не убедившись, что копия легла, значит снять
    // все блокировки без возврата (v4.32.293).
    await withFreshModules(
      async (local, rl) => {
        expect(rl.isBlocked(PEER)).toBe(true);
        expect(local.__kv[GLOBAL_KEY]).toBe(JSON.stringify([PEER]));
      },
      (local) => {
        local.__kv[GLOBAL_KEY] = JSON.stringify([PEER]);
        local.__failWrites(true);
      }
    );
  });
});

describe('блок-лист поднимается с диска не мгновенно (v4.32.317)', () => {
  it('до конца чтения список пуст — это то самое окно на старте', async () => {
    mockLocal.__kv[KEY] = stored([PEER]);
    const rl = new RateLimiter();
    // Ради этого окна и заведён whenReady: конструктор отрабатывает при
    // загрузке модуля, а база к этому моменту ещё не открыта.
    expect(rl.isBlocked(PEER)).toBe(false);
    await rl.whenReady();
    expect(rl.isBlocked(PEER)).toBe(true);
  });

  it('whenReady не отклоняется, если чтение упало', async () => {
    mockLocal.kvGetSecretUpgrading.mockRejectedValueOnce(new Error('база занята'));
    const rl = new RateLimiter();
    await expect(rl.whenReady()).resolves.toBeUndefined();
    expect(rl.isBlocked(PEER)).toBe(false);
  });

  it('после смены профиля ждать надо заново', async () => {
    const rl = await loaded();
    mockLocal.__kv[KEY] = stored([PEER]);
    await rl.resetForProfileSwitch();
    expect(rl.isBlocked(PEER)).toBe(true);
    await expect(rl.getBlockedPubKeys()).resolves.toEqual([PEER]);
  });
});

describe('блокировка, которую не удалось записать (v4.32.317)', () => {
  it('открытие настроек её не снимает', async () => {
    const rl = await loaded();
    mockLocal.__failWrites(true);
    await rl.blockContact(PEER);
    expect(rl.isBlocked(PEER)).toBe(true);
    // Раньше здесь перечитывался диск, а на диске записи нет — и настройки
    // молча показывали пустой список, отменяя действующую блокировку.
    await expect(rl.getBlockedPubKeys()).resolves.toEqual([PEER]);
    expect(rl.isBlocked(PEER)).toBe(true);
  });

  it('но перезапуска она не переживает — обещано ровно это', async () => {
    const first = await loaded();
    mockLocal.__failWrites(true);
    await first.blockContact(PEER);
    mockLocal.__failWrites(false);
    const second = await loaded();
    expect(second.isBlocked(PEER)).toBe(false);
  });
});

describe('на месте списка оказалось не то (v4.32.317)', () => {
  it('объект вместо массива читается как пустой список', async () => {
    mockLocal.__kv[KEY] = stored({ blocked: [PEER] });
    const rl = await loaded();
    expect(rl.isBlocked(PEER)).toBe(false);
    await expect(rl.getBlockedPubKeys()).resolves.toEqual([]);
  });

  it('и не мешает заблокировать заново', async () => {
    mockLocal.__kv[KEY] = stored('строка');
    const rl = await loaded();
    await rl.blockContact(PEER);
    await expect(rl.getBlockedPubKeys()).resolves.toEqual([PEER]);
    const next = await loaded();
    expect(next.isBlocked(PEER)).toBe(true);
  });
});

describe('вопрос о лимите вместо попытки (v4.32.319)', () => {
  const MESSAGE_LIMIT = 50;

  it('спросить можно сколько угодно раз — попытки не тратятся', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 200; i++) expect(rl.messageLimitReached(PEER)).toBe(false);
    // Все пятьдесят на месте: вопрос ничего не израсходовал.
    for (let i = 0; i < MESSAGE_LIMIT; i++) expect(rl.canSendMessage(PEER)).toBe(true);
    expect(rl.messageLimitReached(PEER)).toBe(true);
    expect(rl.canSendMessage(PEER)).toBe(false);
  });

  it('блокировка — это не исчерпанный лимит', async () => {
    const rl = await loaded();
    await rl.blockContact(PEER);
    expect(rl.canSendMessage(PEER)).toBe(false);
    // Разные причины отказа: отложенному сообщению первую ждать бессмысленно,
    // вторую — наоборот, только и остаётся.
    expect(rl.messageLimitReached(PEER)).toBe(false);
  });
});

describe('переполнение таблицы счётчиков (v4.32.317)', () => {
  const MAX_TRACKED = 2000;
  const MESSAGE_LIMIT = 50;

  it('исчерпавший лимит не освобождает себе место наплывом новых ключей', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < MESSAGE_LIMIT; i++) {
      expect(rl.canSendMessage(PEER)).toBe(true);
    }
    expect(rl.canSendMessage(PEER)).toBe(false);

    // Ровно столько, чтобы таблица перевалила за потолок.
    for (let i = 0; i < MAX_TRACKED; i++) rl.canSendMessage(`flood-${i}`);
    rl.canSendMessage(OTHER);

    // Прежде вытеснялся тот, кто появился раньше всех, — то есть сам PEER, и
    // отсчёт пятидесяти начинался для него заново.
    expect(rl.canSendMessage(PEER)).toBe(false);
  });
});

describe('служебный поток не съедает человеческий лимит (v4.32.329)', () => {
  const MESSAGE_LIMIT = 50;
  const CONTROL_LIMIT = 500;

  it('реакции и галочки прочтения не отнимают возможность написать', () => {
    const rl = new RateLimiter();
    // Час активной переписки в группе: рассылка, галочки, реакции, голоса.
    for (let i = 0; i < 200; i++) expect(rl.canSendControl(PEER)).toBe(true);
    // Человек за это время не написал этому собеседнику ни одного сообщения —
    // и все пятьдесят обязаны быть на месте.
    expect(rl.messageLimitReached(PEER)).toBe(false);
    for (let i = 0; i < MESSAGE_LIMIT; i++) expect(rl.canSendMessage(PEER)).toBe(true);
  });

  it('человеческие сообщения не отнимают служебный запас', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < MESSAGE_LIMIT; i++) expect(rl.canSendMessage(PEER)).toBe(true);
    expect(rl.canSendMessage(PEER)).toBe(false);
    expect(rl.canSendControl(PEER)).toBe(true);
  });

  it('свой предел у служебного потока всё же есть', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < CONTROL_LIMIT; i++) expect(rl.canSendControl(PEER)).toBe(true);
    expect(rl.canSendControl(PEER)).toBe(false);
  });

  it('заблокированному не уходит и служебный конверт', async () => {
    const rl = await loaded();
    await rl.blockContact(PEER);
    expect(rl.canSendControl(PEER)).toBe(false);
  });

  it('счёт ведётся по собеседникам раздельно', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < CONTROL_LIMIT; i++) rl.canSendControl(PEER);
    expect(rl.canSendControl(PEER)).toBe(false);
    expect(rl.canSendControl(OTHER)).toBe(true);
  });
});
