/**
 * Занятая база — не испорченная строка (v4.32.786).
 *
 * Дефект. Курсор двигается только после того, как вся пачка спроецирована, —
 * иначе сбой посреди пачки терял бы данные. Чтобы одна неисправимая строка не
 * морозила аккаунт навсегда, v4.32.617 завела предел: после третьего падения
 * подряд строку пропускают и курсор уходит за неё.
 *
 * Но проекция бросает одно и то же исключение и на неисправимом (конверт под
 * чужим ключом, tombstone без разделителя), и на временном (база занята,
 * кончилось место). Различить их по самому исключению нельзя: оно приходит из
 * чужого кода, и текст его никто не обещал. Проходы же идут подряд — при
 * переподключении три штуки укладываются в секунды. Занятой на эти секунды
 * базы хватало, чтобы совершенно исправную строку выбросили НАВСЕГДА: сервер
 * её больше не отдаст, курсор ушёл дальше. Пропадало сообщение, состав
 * группы, запись ленты — молча, с одной строкой в журнале.
 *
 * Правка. Перед приговором спрашиваем у базы, жива ли она: проверяемая запись
 * не бросает, а отвечает `false` и на «database is locked», и на
 * переполненный диск. База ответила — виновата строка, приговор честный. Не
 * ответила — падало не из-за строки, приговор откладывается, курсор стоит.
 * Счётчик попыток при этом не трогают: он уже на пределе, и первый же проход
 * после того, как база освободится, вынесет приговор без новых трёх попыток.
 */
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
  // Ровно так отказывает настоящая проверяемая запись: значение не легло, и об
  // этом сказано ответом, а не исключением.
  kvSetChecked: jest.fn(async () => true),
  validSyncCursor: jest.fn(
    (c: string | null) => c === null || (/^\d+$/.test(c) && Number.isSafeInteger(Number(c))),
  ),
}));

import * as fs from 'fs';
import * as path from 'path';

import { checkOnlineWrite } from '../cachePolicy';
import { pullSyncMutations, pushSyncMutations } from '../syncApi';
import { getSyncState, kvSetChecked, saveSyncState } from '../../storage/local';
import { syncAccountOnce } from '../accountSync';

const online = checkOnlineWrite as jest.MockedFunction<typeof checkOnlineWrite>;
const pull = pullSyncMutations as jest.MockedFunction<typeof pullSyncMutations>;
const push = pushSyncMutations as jest.MockedFunction<typeof pushSyncMutations>;
const readState = getSyncState as jest.MockedFunction<typeof getSyncState>;
const writeState = saveSyncState as jest.MockedFunction<typeof saveSyncState>;
const probe = kvSetChecked as jest.MockedFunction<typeof kvSetChecked>;

const pair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

/**
 * Пачка из одной строки с собственным номером.
 *
 * Счётчик попыток живёт в модуле и переживает тест: у каждой проверки свой
 * идентификатор, иначе они считали бы попытки друг друга.
 */
const arm = (mutationId: string): void => {
  pull.mockResolvedValue({
    serverEpoch: 'epoch-1',
    nextCursor: '2',
    hasMore: false,
    mutations: [{
      mutationId,
      entityKind: 'message' as const,
      entityId: `message-${mutationId}`,
      ownerProfileId: 1,
      revision: 1,
      deleted: false,
      ciphertextB64: 'ZW5j',
      updatedAt: 1,
    }],
  });
};

/** Один проход синхронизации с заданной проекцией. */
const runOnce = (applyMutation: jest.Mock) => syncAccountOnce({
  mnemonic: 'seed',
  pair,
  ownerProfileId: 1,
  applyMutation,
});

/** Три прохода подряд — ровно столько, сколько нужно для приговора. */
const runThrice = async (applyMutation: jest.Mock): Promise<void> => {
  await expect(runOnce(applyMutation)).rejects.toThrow();
  await expect(runOnce(applyMutation)).rejects.toThrow();
  await expect(runOnce(applyMutation)).rejects.toThrow();
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
    acceptedMutationIds: [],
    rejectedMutationIds: [],
    nextCursor: '1',
  });
  writeState.mockResolvedValue();
  probe.mockResolvedValue(true);
});

describe('база занята — строку не выбрасывают', () => {
  it('курсор стоит на месте, пока база не отвечает', async () => {
    arm('busy-hold');
    probe.mockResolvedValue(false);
    const applyMutation = jest.fn().mockRejectedValue(new Error('database is locked'));

    // До правки третий проход объявлял строку испорченной и уводил курсор за
    // неё: исправное сообщение пропадало навсегда.
    await runThrice(applyMutation);
    expect(writeState).not.toHaveBeenCalled();
  });

  it('база освободилась — приговор выносят первым же проходом', async () => {
    arm('busy-then-free');
    probe.mockResolvedValue(false);
    const applyMutation = jest.fn().mockRejectedValue(new Error('database is locked'));
    await runThrice(applyMutation);

    // Счётчик остался на пределе: новых трёх попыток не нужно.
    probe.mockResolvedValue(true);
    const result = await runOnce(applyMutation);
    expect(result.status).toBe('synced');
    expect(writeState).toHaveBeenCalledWith(1, expect.objectContaining({ cursor: '2' }));
  });

  it('сколько бы проходов ни прошло, занятая база строку не съедает', async () => {
    arm('busy-forever');
    probe.mockResolvedValue(false);
    const applyMutation = jest.fn().mockRejectedValue(new Error('database is locked'));
    await runThrice(applyMutation);
    await runThrice(applyMutation);
    expect(writeState).not.toHaveBeenCalled();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: испорченную строку по-прежнему пропускают', () => {
  it('база отвечает — после предела попыток курсор идёт дальше', async () => {
    arm('really-poison');
    const applyMutation = jest.fn().mockRejectedValue(new Error('не расшифровать'));
    await expect(runOnce(applyMutation)).rejects.toThrow();
    await expect(runOnce(applyMutation)).rejects.toThrow();

    const result = await runOnce(applyMutation);
    expect(result.status).toBe('synced');
    expect(writeState).toHaveBeenCalledWith(1, expect.objectContaining({ cursor: '2' }));
  });

  it('первые попытки курсор не двигают и базу не тревожат', async () => {
    arm('early-attempts');
    const applyMutation = jest.fn().mockRejectedValue(new Error('не расшифровать'));
    await expect(runOnce(applyMutation)).rejects.toThrow();
    // Проба — не на каждый сбой: до предела попыток спрашивать не о чем.
    expect(probe).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
  });

  it('удачная проекция базу не трогает вовсе', async () => {
    arm('healthy');
    const result = await runOnce(jest.fn().mockResolvedValue(undefined));
    expect(result.status).toBe('synced');
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'accountSync.ts'), 'utf8');
  const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

  it('проекция приходит снаружи — её исключению верить нельзя', () => {
    // Тип задан вызывающим: что именно бросит проекция, этот модуль не знает.
    expect(SRC).toContain('export type SyncProjection = (mutation: SyncMutation) => Promise<void>;');
    expect(SRC).toContain('await options.applyMutation(mutation);');
  });

  it('приговор строке уводит курсор за неё безвозвратно', () => {
    expect(SRC).toContain('const POISON_MAX_ATTEMPTS = 3;');
    expect(SRC).toContain("log.warn('sync_pull_row_poisoned', {");
    expect(SRC).toContain('await saveSyncState(options.ownerProfileId, {');
  });

  it('проба спрашивает базу проверяемой записью, а та не бросает', () => {
    expect(LOCAL).toContain('export async function kvSetChecked(key: string, value: string): Promise<boolean> {');
    expect(SRC).toContain('return kvSetChecked(POISON_PROBE_KEY, String(Date.now()));');
    expect(SRC).toContain('if (!(await databaseAnswers())) {');
  });
});
