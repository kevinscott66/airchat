/**
 * Памятка «имя уже переиздано» врала, когда издавать было нечем (v4.32.980).
 *
 * Дефект. `republishOwnUsernameToDirectory` ставит отметку «отправлено» до
 * сетевого запроса — нарочно, чтобы два одновременных захода не сходили в
 * реестр дважды. Откат этой отметки был написан для двух исходов: сервер
 * ответил `offline` и запрос бросил исключение. А выходов, на которых запроса
 * не будет вовсе, в функции четыре: ещё два стоят между отметкой и запросом —
 * нет ключа переписки профиля (`activeProfilePair()` вернул `null`) и нет
 * seed-фразы. Оба выходили молча, с уже поставленной отметкой.
 *
 * Цена. Оба «нет» — про раннюю секунду после запуска: менеджер профилей ещё
 * не поднялся, хранилище ещё занято. Экран профиля, открытый в эту секунду,
 * ставил отметку и уходил ни с чем, а все следующие заходы видели «уже
 * отправлено» и молчали до самого перезапуска приложения. Переиздание — это
 * не роскошь: оно чинит записи, сделанные до v4.32.607 (без ключа — по @имени
 * никуда не перейти) и до v4.32.722 (без имени — незнакомец видит «Без
 * имени»). Ровно тот заход, который должен был починить запись, её и
 * блокировал.
 *
 * Переименование дефект не задевал: ключ памятки — само содержимое
 * («юзернейм\nимя»), и новое имя даёт новый ключ. Страдало повторение того же
 * содержимого — то есть починка старой записи, которой никакое новое событие
 * уже не поможет.
 *
 * Правка. Откат вынесен в замыкание `forget()` и зовётся на всех четырёх
 * выходах без отправки — теми же словами, какими был написан откат в `catch`.
 *
 * Границы. Удачная отправка отметку оставляет: сетевой запрос на каждое
 * открытие вкладки — как раз то, ради чего памятка и заведена.
 */
import fs from 'fs';
import path from 'path';

jest.mock('../../backup/seedPhrase', () => ({
  getStoredMnemonic: jest.fn(),
  deriveKeyPairFromMnemonic: jest.fn(() => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(64),
  })),
}));
jest.mock('../../sync/syncApi', () => ({
  claimSyncUsername: jest.fn(),
  releaseSyncUsername: jest.fn(),
}));
jest.mock('../ownProfile', () => ({
  getOwnDisplayNameFor: jest.fn(),
  getOwnUsernameFor: jest.fn(),
  isUsernameTakenByAnotherProfile: jest.fn(),
  setOwnUsername: jest.fn(),
}));
const mockProfilePair = {
  publicKey: new Uint8Array(32).fill(7),
  secretKey: new Uint8Array(64).fill(7),
};
jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: jest.fn(() => ({ id: 0 })),
    getActiveKeyPair: jest.fn(() => mockProfilePair),
  },
}));
jest.mock('../ownBadge', () => ({ ownBadgeGrantFor: jest.fn() }));
jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  return {
    __kv: kv,
    kvSet: jest.fn(async (k: string, v: string) => { kv[k] = v; }),
    kvSetChecked: jest.fn(async (k: string, v: string) => { kv[k] = v; return true; }),
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvTryListKeysByPrefix: jest.fn(async (p: string) => Object.keys(kv).filter((k) => k.startsWith(p))),
  };
});
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { getStoredMnemonic } from '../../backup/seedPhrase';
import { claimSyncUsername } from '../../sync/syncApi';
import { ownBadgeGrantFor } from '../ownBadge';
import { getOwnDisplayNameFor, getOwnUsernameFor } from '../ownProfile';
import { profileManager } from '../profileManager';
import { republishOwnUsernameToDirectory } from '../usernameRegistry';

const mnemonic = getStoredMnemonic as jest.MockedFunction<typeof getStoredMnemonic>;
const claim = claimSyncUsername as jest.MockedFunction<typeof claimSyncUsername>;
const badge = ownBadgeGrantFor as jest.MockedFunction<typeof ownBadgeGrantFor>;
const ownName = getOwnDisplayNameFor as jest.MockedFunction<typeof getOwnDisplayNameFor>;
const ownUsername = getOwnUsernameFor as jest.MockedFunction<typeof getOwnUsernameFor>;
const getPair = profileManager.getActiveKeyPair as jest.MockedFunction<
  typeof profileManager.getActiveKeyPair
>;

/**
 * Памятка живёт в модуле и переживает `clearAllMocks`, а изолировать модуль
 * ради каждого случая — значит проверять не тот объект, который работает в
 * приложении. Поэтому у каждого теста своё содержимое: ключ памятки — это
 * «юзернейм\nимя», и разные имена в память друг другу не лезут.
 */
let nth = 0;

beforeEach(() => {
  jest.clearAllMocks();
  nth += 1;
  mnemonic.mockResolvedValue('word '.repeat(11) + 'word');
  claim.mockResolvedValue({ ok: true, username: `kevin_s${nth}` });
  badge.mockResolvedValue(null);
  ownName.mockResolvedValue(`Рита ${nth}`);
  ownUsername.mockResolvedValue(`margarita${nth}`);
  getPair.mockImplementation(() => mockProfilePair);
});

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

describe('заход, на котором отправлять было нечем, следующему не мешает', () => {
  it('менеджер профилей не поднялся — второй заход всё-таки идёт в реестр', async () => {
    getPair.mockImplementation(() => { throw new Error('профили не подняты'); });
    await republishOwnUsernameToDirectory();
    expect(claim).not.toHaveBeenCalled();

    getPair.mockImplementation(() => mockProfilePair);
    await republishOwnUsernameToDirectory();

    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('seed-фразы не было — второй заход всё-таки идёт в реестр', async () => {
    mnemonic.mockResolvedValue(null);
    await republishOwnUsernameToDirectory();
    expect(claim).not.toHaveBeenCalled();

    mnemonic.mockResolvedValue('word '.repeat(11) + 'word');
    await republishOwnUsernameToDirectory();

    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('запись доезжает такой, какой её ждут: с ключом профиля и именем', async () => {
    mnemonic.mockResolvedValue(null);
    await republishOwnUsernameToDirectory();
    mnemonic.mockResolvedValue('word '.repeat(11) + 'word');
    await republishOwnUsernameToDirectory();

    expect(claim).toHaveBeenLastCalledWith(
      expect.any(String), expect.anything(), `margarita${nth}`, 0, null,
      mockProfilePair, `Рита ${nth}`,
    );
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: памятка по-прежнему бережёт сеть', () => {
  it('удачная отправка второй раз в реестр не ходит', async () => {
    await republishOwnUsernameToDirectory();
    await republishOwnUsernameToDirectory();

    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('сменилось имя — уходит заново, это и есть повод', async () => {
    await republishOwnUsernameToDirectory();
    ownName.mockResolvedValue(`Маргарита ${nth}`);
    await republishOwnUsernameToDirectory();

    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('недоступный реестр отправкой не считается — откат тут был и раньше', async () => {
    claim.mockResolvedValueOnce({ ok: false, reason: 'offline' });
    await republishOwnUsernameToDirectory();
    await republishOwnUsernameToDirectory();

    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('ГРАНИЦА: имени нет вовсе — в реестр не ходят и памятку не трогают', async () => {
    ownUsername.mockResolvedValue(null);
    await republishOwnUsernameToDirectory();
    expect(claim).not.toHaveBeenCalled();

    ownUsername.mockResolvedValue(`margarita${nth}`);
    await republishOwnUsernameToDirectory();

    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('ГРАНИЦА: отказ реестра по существу отправкой считается', async () => {
    claim.mockResolvedValue({ ok: false, reason: 'taken' });
    await republishOwnUsernameToDirectory();
    await republishOwnUsernameToDirectory();

    // Не `offline`: сервер ответил, и ответ его не изменится от повтора.
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ключ переписки профиля и правда бывает недоступен', () => {
    const body = codeOnly(read('core/identity/usernameRegistry.ts'));
    expect(body).toContain('function activeProfilePair(): KeyPairBytes | null {');
    expect(body).toContain('return profileManager.getActiveKeyPair();');
    expect(body).toContain('return null;');
  });

  it('отметка по-прежнему ставится до сетевого запроса', () => {
    // Внутри самой функции: `claimSyncUsername` зовёт и `saveOwnUsernameGlobally`
    // выше по файлу, и без границы проверка мерила бы порядок не тех строк.
    const whole = codeOnly(read('core/identity/usernameRegistry.ts'));
    const at = whole.indexOf('export async function republishOwnUsernameToDirectory');
    expect(at).toBeGreaterThan(0);
    const body = whole.slice(at, whole.indexOf('\n}\n', at));
    const set = body.indexOf('republished.set(pid, sent);');
    const net = body.indexOf('const claim = await claimSyncUsername(');
    expect(set).toBeGreaterThan(0);
    expect(net).toBeGreaterThan(set);
  });

  it('чинить старые записи больше нечем: другого повода сходить в сеть нет', () => {
    const screen = codeOnly(read('ui/screens/ProfileScreen.tsx'));
    expect(screen).toContain('republishOwnUsernameToDirectory()');
  });
});

describe('ЗАКРЕПКА', () => {
  it('откат один на все выходы без отправки', () => {
    const body = codeOnly(read('core/identity/usernameRegistry.ts'));
    expect(body).toContain('const forget = (): void => {');
    expect(body).toContain('if (!pair) { forget(); return; }');
    expect(body).toContain('if (!mnemonic) { forget(); return; }');
    expect(body).toContain("if (!claim.ok && claim.reason === 'offline') forget();");
  });
});
