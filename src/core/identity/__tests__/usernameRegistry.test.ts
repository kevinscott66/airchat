/**
 * Реестр юзернеймов на стороне клиента: порядок «сперва бронь, потом запись»
 * и поведение при недоступном сервере.
 */
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
const mockProfilePair = { publicKey: new Uint8Array(32).fill(7), secretKey: new Uint8Array(64).fill(7) };
jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: jest.fn(() => ({ id: 0 })),
    getActiveKeyPair: jest.fn(() => mockProfilePair),
  },
}));
jest.mock('../ownBadge', () => ({
  ownBadgeGrantFor: jest.fn(),
}));
jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  return {
    __kv: kv,
    kvSet: jest.fn(async (k: string, v: string) => { kv[k] = v; }),
    // v4.32.785: заметка об освобождении имени пишется проверяемой формой.
    kvSetChecked: jest.fn(async (k: string, v: string) => { kv[k] = v; return true; }),
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvTryListKeysByPrefix: jest.fn(async (p: string) => Object.keys(kv).filter((k) => k.startsWith(p))),
  };
});

import { getStoredMnemonic } from '../../backup/seedPhrase';
import { claimSyncUsername } from '../../sync/syncApi';
import { ownBadgeGrantFor } from '../ownBadge';
import { getOwnDisplayNameFor, getOwnUsernameFor, isUsernameTakenByAnotherProfile, setOwnUsername } from '../ownProfile';
import { profileManager } from '../profileManager';
import { releaseSyncUsername } from '../../sync/syncApi';
import {
  releaseOwnUsernameGlobally,
  republishOwnUsernameToDirectory,
  retryPendingUsernameReleases,
  saveOwnUsernameGlobally,
} from '../usernameRegistry';

const mnemonic = getStoredMnemonic as jest.MockedFunction<typeof getStoredMnemonic>;
const claim = claimSyncUsername as jest.MockedFunction<typeof claimSyncUsername>;
const localTaken = isUsernameTakenByAnotherProfile as jest.MockedFunction<typeof isUsernameTakenByAnotherProfile>;
const saveLocal = setOwnUsername as jest.MockedFunction<typeof setOwnUsername>;
const badge = ownBadgeGrantFor as jest.MockedFunction<typeof ownBadgeGrantFor>;
const ownName = getOwnDisplayNameFor as jest.MockedFunction<typeof getOwnDisplayNameFor>;
const ownUsername = getOwnUsernameFor as jest.MockedFunction<typeof getOwnUsernameFor>;
const release = releaseSyncUsername as jest.MockedFunction<typeof releaseSyncUsername>;
const localKv = jest.requireMock('../../storage/local') as {
  __kv: Record<string, string>;
  kvTryListKeysByPrefix: jest.Mock;
};
const PENDING = 'airchat_username_release_pending:';

beforeEach(() => {
  jest.clearAllMocks();
  mnemonic.mockResolvedValue('word '.repeat(11) + 'word');
  localTaken.mockResolvedValue(false);
  saveLocal.mockResolvedValue(true);
  claim.mockResolvedValue({ ok: true, username: 'kevin_s' });
  badge.mockResolvedValue(null);
  ownName.mockResolvedValue('Рита');
  ownUsername.mockResolvedValue('margarita');
  release.mockResolvedValue({ ok: true });
  for (const k of Object.keys(localKv.__kv)) delete localKv.__kv[k];
});

test('занимает имя в реестре и только потом пишет его локально', async () => {
  await expect(saveOwnUsernameGlobally('kevin_s')).resolves.toEqual({ ok: true, scope: 'global' });
  expect(claim).toHaveBeenCalledWith(expect.any(String), expect.anything(), 'kevin_s', 0, null, mockProfilePair, 'Рита');
  expect(saveLocal).toHaveBeenCalledWith('kevin_s');
});

// v4.32.548: список оставленных приложению имён стоит и на сервере, поэтому
// разрешение занять `@founder` надо предъявить и там — иначе клиентская
// разблокировка упирается в отказ реестра и имя остаётся только локальным.
test('бумага на галочку уезжает вместе с заявкой на имя', async () => {
  badge.mockResolvedValue('{"payload":"…","signature":"…"}');
  claim.mockResolvedValue({ ok: true, username: 'founder' });
  await expect(saveOwnUsernameGlobally('founder')).resolves.toEqual({ ok: true, scope: 'global' });
  expect(claim).toHaveBeenCalledWith(
    expect.any(String), expect.anything(), 'founder', 0, '{"payload":"…","signature":"…"}', mockProfilePair, 'Рита',
  );
});

// v4.32.607: имя ведёт к ключу ПЕРЕПИСКИ профиля, а не к ключу аккаунта — у
// дополнительных профилей они разные. Если менеджер профилей ещё не готов,
// имя всё равно занимается, просто без записи в справочник.
test('ключ профиля уезжает в справочник вместе с именем', async () => {
  const getPair = profileManager.getActiveKeyPair as jest.MockedFunction<typeof profileManager.getActiveKeyPair>;
  getPair.mockImplementationOnce(() => { throw new Error('профили не подняты'); });
  await expect(saveOwnUsernameGlobally('kevin_s')).resolves.toEqual({ ok: true, scope: 'global' });
  expect(claim).toHaveBeenCalledWith(expect.any(String), expect.anything(), 'kevin_s', 0, null, null, 'Рита');
});

test('занятое чужим аккаунтом имя не пишется даже локально', async () => {
  claim.mockResolvedValue({ ok: false, reason: 'taken' });
  await expect(saveOwnUsernameGlobally('kevin_s')).resolves.toEqual({ ok: false, reason: 'taken' });
  expect(saveLocal).not.toHaveBeenCalled();
});

test('отказ реестра по правилам имени отдаётся отдельной причиной', async () => {
  claim.mockResolvedValue({ ok: false, reason: 'rejected' });
  await expect(saveOwnUsernameGlobally('support')).resolves.toEqual({ ok: false, reason: 'rejected' });
  expect(saveLocal).not.toHaveBeenCalled();
});

test('недоступный сервер не мешает переименоваться, но брони не даёт', async () => {
  claim.mockResolvedValue({ ok: false, reason: 'offline' });
  await expect(saveOwnUsernameGlobally('kevin_s')).resolves.toEqual({ ok: true, scope: 'local' });
  expect(saveLocal).toHaveBeenCalledWith('kevin_s');
});

test('без seed-фразы реестр не спрашивается', async () => {
  mnemonic.mockResolvedValue(null);
  await expect(saveOwnUsernameGlobally('kevin_s')).resolves.toEqual({ ok: true, scope: 'local' });
  expect(claim).not.toHaveBeenCalled();
});

test('локальный дубликат отсекается до сетевого запроса', async () => {
  localTaken.mockResolvedValue(true);
  await expect(saveOwnUsernameGlobally('kevin_s')).resolves.toEqual({ ok: false, reason: 'local' });
  expect(claim).not.toHaveBeenCalled();
});

// v4.32.722: имя, которым профиль назвался, живёт в реестре рядом с
// юзернеймом — его видит тот, кто пришёл по @имени до переписки. Уходит оно
// заново после переименования, но не на каждое открытие экрана профиля.
test('имя профиля переиздаётся в реестре при смене и только при смене', async () => {
  await republishOwnUsernameToDirectory();
  expect(claim).toHaveBeenLastCalledWith(
    expect.any(String), expect.anything(), 'margarita', 0, null, mockProfilePair, 'Рита',
  );
  await republishOwnUsernameToDirectory();
  expect(claim).toHaveBeenCalledTimes(1);
  ownName.mockResolvedValue('Маргарита');
  await republishOwnUsernameToDirectory();
  expect(claim).toHaveBeenCalledTimes(2);
  expect(claim).toHaveBeenLastCalledWith(
    expect.any(String), expect.anything(), 'margarita', 0, null, mockProfilePair, 'Маргарита',
  );
});

test('недоступный реестр не засчитывается как отправка имени', async () => {
  ownName.mockResolvedValue('Рита офлайн');
  claim.mockResolvedValueOnce({ ok: false, reason: 'offline' });
  await republishOwnUsernameToDirectory();
  await republishOwnUsernameToDirectory();
  expect(claim).toHaveBeenCalledTimes(2);
});

/**
 * v4.32.742. Имя удалённого профиля отпускалось одним запросом, и его отказ
 * глотался молча. Профили удаляют и в самолёте: имя оставалось в реестре
 * навсегда — указывало на ключ, которым больше никто не пользуется, письма на
 * него уходили в никуда, а вернуть его себе было нельзя. Само оно не
 * освобождалось: сервер снимает старую запись профиля только когда тот же
 * номер занимает другое имя, а номера не переиспользуются.
 */
describe('имя удалённого профиля отпускается даже с третьего раза', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: при живой сети имя отпускается сразу и заметки не остаётся', async () => {
    await releaseOwnUsernameGlobally(3);
    expect(release).toHaveBeenCalledWith(expect.any(String), expect.anything(), 3);
    expect(Object.keys(localKv.__kv)).toEqual([]);
  });

  it('сеть не ответила — заметка остаётся на диске', async () => {
    release.mockRejectedValueOnce(new Error('offline'));
    await releaseOwnUsernameGlobally(3);
    expect(localKv.__kv[`${PENDING}3`]).toBeDefined();
  });

  it('следующий заход добирает: имя всё-таки отпускается', async () => {
    release.mockRejectedValueOnce(new Error('offline'));
    await releaseOwnUsernameGlobally(3);
    release.mockClear();
    await retryPendingUsernameReleases();
    expect(release).toHaveBeenCalledWith(expect.any(String), expect.anything(), 3);
    expect(localKv.__kv[`${PENDING}3`]).toBeUndefined();
  });

  it('и разбирается он сам, с открытия экрана профиля', async () => {
    release.mockRejectedValueOnce(new Error('offline'));
    await releaseOwnUsernameGlobally(3);
    release.mockClear();
    await republishOwnUsernameToDirectory();
    // Экран профиля — единственное место, откуда этот разбор вообще делается:
    // своего повода сходить в сеть у брошенной заметки нет.
    expect(release).toHaveBeenCalledWith(expect.any(String), expect.anything(), 3);
    expect(localKv.__kv[`${PENDING}3`]).toBeUndefined();
  });

  it('сервер ответил «такой записи не было» — заметка снимается, а не висит вечно', async () => {
    release.mockResolvedValueOnce({ ok: false });
    await releaseOwnUsernameGlobally(3);
    expect(localKv.__kv[`${PENDING}3`]).toBeUndefined();
  });

  it('без seed-фразы заметка остаётся: отпустить имя нечем', async () => {
    mnemonic.mockResolvedValue(null);
    await releaseOwnUsernameGlobally(3);
    expect(release).not.toHaveBeenCalled();
    expect(localKv.__kv[`${PENDING}3`]).toBeDefined();
  });

  it('нечитаемый список заметок — не «заметок нет»', async () => {
    release.mockRejectedValueOnce(new Error('offline'));
    await releaseOwnUsernameGlobally(3);
    localKv.kvTryListKeysByPrefix.mockResolvedValueOnce(null);
    release.mockClear();
    await retryPendingUsernameReleases();
    expect(release).not.toHaveBeenCalled();
    expect(localKv.__kv[`${PENDING}3`]).toBeDefined();
  });

  it('связи нет — остальные заметки не тратятся впустую и остаются на месте', async () => {
    release.mockRejectedValue(new Error('offline'));
    await releaseOwnUsernameGlobally(3);
    await releaseOwnUsernameGlobally(4);
    release.mockClear();
    await retryPendingUsernameReleases();
    expect(release).toHaveBeenCalledTimes(1);
    expect(Object.keys(localKv.__kv).sort()).toEqual([`${PENDING}3`, `${PENDING}4`]);
    release.mockResolvedValue({ ok: true });
  });
});
