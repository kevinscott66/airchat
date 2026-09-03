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
  isUsernameTakenByAnotherProfile: jest.fn(),
  setOwnUsername: jest.fn(),
}));
jest.mock('../profileManager', () => ({
  profileManager: { getActiveProfile: jest.fn(() => ({ id: 0 })) },
}));
jest.mock('../ownBadge', () => ({
  ownBadgeGrantFor: jest.fn(),
}));

import { getStoredMnemonic } from '../../backup/seedPhrase';
import { claimSyncUsername } from '../../sync/syncApi';
import { ownBadgeGrantFor } from '../ownBadge';
import { isUsernameTakenByAnotherProfile, setOwnUsername } from '../ownProfile';
import { saveOwnUsernameGlobally } from '../usernameRegistry';

const mnemonic = getStoredMnemonic as jest.MockedFunction<typeof getStoredMnemonic>;
const claim = claimSyncUsername as jest.MockedFunction<typeof claimSyncUsername>;
const localTaken = isUsernameTakenByAnotherProfile as jest.MockedFunction<typeof isUsernameTakenByAnotherProfile>;
const saveLocal = setOwnUsername as jest.MockedFunction<typeof setOwnUsername>;
const badge = ownBadgeGrantFor as jest.MockedFunction<typeof ownBadgeGrantFor>;

beforeEach(() => {
  jest.clearAllMocks();
  mnemonic.mockResolvedValue('word '.repeat(11) + 'word');
  localTaken.mockResolvedValue(false);
  saveLocal.mockResolvedValue(true);
  claim.mockResolvedValue({ ok: true, username: 'kevin_s' });
  badge.mockResolvedValue(null);
});

test('занимает имя в реестре и только потом пишет его локально', async () => {
  await expect(saveOwnUsernameGlobally('kevin_s')).resolves.toEqual({ ok: true, scope: 'global' });
  expect(claim).toHaveBeenCalledWith(expect.any(String), expect.anything(), 'kevin_s', 0, null);
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
    expect.any(String), expect.anything(), 'founder', 0, '{"payload":"…","signature":"…"}',
  );
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
