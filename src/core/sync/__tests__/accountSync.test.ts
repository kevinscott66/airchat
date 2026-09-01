jest.mock('../cachePolicy', () => ({
  checkOnlineWrite: jest.fn(),
}));
jest.mock('../syncApi', () => ({
  pullSyncMutations: jest.fn(),
  pushSyncMutations: jest.fn(),
}));
jest.mock('../../storage/local', () => ({
  getSyncState: jest.fn(),
  saveSyncState: jest.fn(),
}));

import { checkOnlineWrite } from '../cachePolicy';
import { pullSyncMutations, pushSyncMutations } from '../syncApi';
import { getSyncState, saveSyncState } from '../../storage/local';
import { syncAccountOnce } from '../accountSync';

const online = checkOnlineWrite as jest.MockedFunction<typeof checkOnlineWrite>;
const pull = pullSyncMutations as jest.MockedFunction<typeof pullSyncMutations>;
const push = pushSyncMutations as jest.MockedFunction<typeof pushSyncMutations>;
const readState = getSyncState as jest.MockedFunction<typeof getSyncState>;
const writeState = saveSyncState as jest.MockedFunction<typeof saveSyncState>;

const pair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };
const mutation = {
  mutationId: 'm-1',
  entityKind: 'message' as const,
  entityId: 'message-1',
  ownerProfileId: 1,
  revision: 1,
  deleted: false,
  ciphertextB64: 'ZW5j',
  updatedAt: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  online.mockResolvedValue({ ok: true, path: 'allow', reachability: 'online' });
  readState.mockResolvedValue({
    ownerProfileId: 1,
    cursor: null,
    serverEpoch: null,
    lastPullAt: null,
    lastPushAt: null,
  });
  push.mockResolvedValue({
    serverEpoch: 'epoch-1',
    acceptedMutationIds: ['m-1'],
    rejectedMutationIds: [],
    nextCursor: '1',
  });
  pull.mockResolvedValue({
    serverEpoch: 'epoch-1',
    nextCursor: '2',
    hasMore: false,
    mutations: [mutation],
  });
  writeState.mockResolvedValue();
});

test('does not push while offline', async () => {
  online.mockResolvedValue({ ok: false, reason: 'offline', reachability: 'disconnected' });
  const result = await syncAccountOnce({
    mnemonic: 'seed',
    pair,
    ownerProfileId: 1,
    pendingMutations: [mutation],
    applyMutation: jest.fn(),
  });

  expect(result.status).toBe('offline');
  expect(push).not.toHaveBeenCalled();
  expect(pull).not.toHaveBeenCalled();
  expect(writeState).not.toHaveBeenCalled();
});

test('advances cursor only after all pulled rows are applied', async () => {
  const applyMutation = jest.fn().mockResolvedValue(undefined);
  const result = await syncAccountOnce({
    mnemonic: 'seed',
    pair,
    ownerProfileId: 1,
    pendingMutations: [mutation],
    applyMutation,
  });

  expect(result.status).toBe('synced');
  expect(push).toHaveBeenCalledTimes(1);
  expect(pull).toHaveBeenCalledWith('seed', pair, null, 1, 100);
  expect(applyMutation).toHaveBeenCalledWith(mutation);
  expect(writeState).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ cursor: '2' }));
});

test('keeps cursor unchanged when projection fails', async () => {
  const applyMutation = jest.fn().mockRejectedValue(new Error('decrypt failed'));
  await expect(syncAccountOnce({
    mnemonic: 'seed',
    pair,
    ownerProfileId: 1,
    applyMutation,
  })).rejects.toThrow('decrypt failed');

  expect(writeState).not.toHaveBeenCalledWith(1, expect.objectContaining({ cursor: '2' }));
});

/**
 * Строка чужого профиля не проецируется (v4.32.523).
 *
 * Запрашиваем мы один профиль, но что вернёт сервер — его дело, и до этого
 * круга не спрашивал никто. Строка с чужим `ownerProfileId` проецировалась как
 * есть, а удаление уходило в хранилище с этим же чужим номером — то есть
 * сервер мог стереть данные СОСЕДНЕГО аккаунта на телефоне, того, который
 * сейчас даже не открыт. Пропускаем такую строку, но разбор не роняем: иначе
 * одной записью можно было бы остановить курсор навсегда.
 */
describe('пришедшие строки проверяются на принадлежность', () => {
  const foreign = { ...mutation, mutationId: 'm-2', ownerProfileId: 2 };

  async function pullRows(rows: typeof mutation[]): Promise<jest.Mock> {
    pull.mockResolvedValue({
      serverEpoch: 'epoch-1', nextCursor: '2', hasMore: false, mutations: rows,
    });
    const applyMutation = jest.fn().mockResolvedValue(undefined);
    await syncAccountOnce({ mnemonic: 'seed', pair, ownerProfileId: 1, applyMutation });
    return applyMutation;
  }

  test('строка чужого профиля не доходит до проекции', async () => {
    expect(await pullRows([foreign])).not.toHaveBeenCalled();
  });

  test('своя строка в том же ответе применяется', async () => {
    expect(await pullRows([foreign, mutation])).toHaveBeenCalledWith(mutation);
  });

  test('курсор всё равно сдвигается: иначе синхронизация встанет навсегда', async () => {
    await pullRows([foreign]);
    expect(writeState).toHaveBeenCalledWith(1, expect.objectContaining({ cursor: '2' }));
  });

  test('дробная ревизия отбрасывается: на ней держится защита от отката', async () => {
    expect(await pullRows([{ ...mutation, revision: 1.5 }])).not.toHaveBeenCalled();
  });

  test('нулевая и отрицательная ревизия отбрасываются', async () => {
    expect(await pullRows([{ ...mutation, revision: 0 }])).not.toHaveBeenCalled();
    expect(await pullRows([{ ...mutation, revision: -3 }])).not.toHaveBeenCalled();
  });

  test('невозможное время правки отбрасывается', async () => {
    expect(await pullRows([{ ...mutation, updatedAt: Number.NaN }])).not.toHaveBeenCalled();
  });
});
