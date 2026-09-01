/**
 * Решения о приватности — по набору на аккаунт (v4.32.311).
 *
 * Четыре переключателя и просьба «сообщить, когда появится» лежали под общими
 * именами — одни на устройство. Профили заводят затем, чтобы разделить, кем
 * человек представляется; общая настройка это разделение молча отменяла, а в
 * настройках при этом показывалось то самое положение переключателя, которое
 * человек когда-то выбрал — только для другого аккаунта.
 */
const kv: Record<string, string> = {};
let mockKvBroken = false;
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => {
    if (mockKvBroken) throw new Error('kv unavailable');
    return kv[k] ?? null;
  }),
  kvTryGet: jest.fn(async (k: string) => (mockKvBroken ? null : { value: kv[k] ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { kv[k] = v; }),
  kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
}));

let mockActiveProfileId = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveProfileId }) },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  notifyOnlineGet,
  notifyOnlineSet,
  privacyPrefBool,
  privacyPrefGet,
  privacyPrefSet,
  readReceiptsAllowed,
} from '../privacyPrefs';

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  mockActiveProfileId = 1;
  mockKvBroken = false;
});

describe('переключатели приватности', () => {
  it('записанное одним аккаунтом не видно другому', async () => {
    // Ровно тот случай, ради которого профили и заводят: второй аккаунт не
    // должен унаследовать «когда я в сети — видно всем» от первого.
    await privacyPrefSet('privacy_last_seen_visibility', 'everybody');
    mockActiveProfileId = 2;
    expect(await privacyPrefGet('privacy_last_seen_visibility')).toBeNull();
    await privacyPrefSet('privacy_last_seen_visibility', 'nobody');
    mockActiveProfileId = 1;
    expect(await privacyPrefGet('privacy_last_seen_visibility')).toBe('everybody');
  });

  it('запись без префикса достаётся первому профилю', async () => {
    // Так писали, когда профиль был один: значение принадлежит первому.
    kv['privacy_only_contacts_msg'] = 'true';
    expect(await privacyPrefBool('privacy_only_contacts_msg')).toBe(true);
    // И забирается себе — оставленная лежать, она снова досталась бы всем.
    expect(kv['p1:privacy_only_contacts_msg']).toBe('true');
    expect(kv['privacy_only_contacts_msg']).toBeUndefined();
  });

  it('остальным профилям старая общая запись не наследуется', async () => {
    kv['privacy_only_contacts_msg'] = 'true';
    mockActiveProfileId = 2;
    expect(await privacyPrefBool('privacy_only_contacts_msg')).toBe(false);
    // И не забирается: она принадлежит первому и должна остаться ему.
    expect(kv['privacy_only_contacts_msg']).toBe('true');
  });

  it('своё значение перебивает старую общую запись', async () => {
    kv['privacy_disable_read_receipts'] = 'true';
    kv['p1:privacy_disable_read_receipts'] = 'false';
    expect(await privacyPrefBool('privacy_disable_read_receipts')).toBe(false);
  });

  it('запись первого профиля убирает общую', async () => {
    // Иначе откат на чтение по старому имени вернул бы прежний выбор.
    kv['privacy_only_contacts_group'] = 'true';
    await privacyPrefSet('privacy_only_contacts_group', 'false');
    expect(kv['privacy_only_contacts_group']).toBeUndefined();
    expect(kv['p1:privacy_only_contacts_group']).toBe('false');
  });

  it('ключи лежат в namespace профиля — их уносит удаление профиля', async () => {
    // Уборка при удалении профиля сметает `p<id>:%`; пока ключи были общими,
    // удалённый аккаунт оставлял свои решения следующему.
    mockActiveProfileId = 3;
    await privacyPrefSet('privacy_last_seen_visibility', 'contacts');
    expect(Object.keys(kv)).toEqual(['p3:privacy_last_seen_visibility']);
  });
});

describe('«сообщить, когда появится»', () => {
  const PEER = 'AAAAbbbbCCCC';

  it('просьба одного аккаунта не всплывает у другого', async () => {
    // Контакты у профилей разные: уведомление про человека, которого второй
    // аккаунт не добавлял, показало бы связь между аккаунтами на экране блокировки.
    await notifyOnlineSet(PEER, true);
    mockActiveProfileId = 2;
    expect(await notifyOnlineGet(PEER)).toBe(false);
  });

  it('снятая просьба больше не срабатывает', async () => {
    await notifyOnlineSet(PEER, true);
    await notifyOnlineSet(PEER, false);
    expect(await notifyOnlineGet(PEER)).toBe(false);
  });

  it('просьба, записанная до v4.32.311, достаётся первому профилю', async () => {
    kv[`notify_online_${PEER}`] = '1';
    expect(await notifyOnlineGet(PEER)).toBe(true);
    mockActiveProfileId = 2;
    expect(await notifyOnlineGet(PEER)).toBe(false);
  });
});

describe('отметки о прочтении', () => {
  it('по умолчанию отправляются', async () => {
    // Переключатель никто не трогал — поведение прежнее, иначе версия молча
    // отняла бы у собеседников привычные «прочитано».
    expect(await readReceiptsAllowed()).toBe(true);
  });

  it('выключенные — не отправляются', async () => {
    await privacyPrefSet('privacy_disable_read_receipts', 'true');
    expect(await readReceiptsAllowed()).toBe(false);
  });

  it('нечитаемая настройка означает молчание', async () => {
    // Неотправленную отметку можно послать позже, отправленную — не отозвать.
    // Поэтому неизвестность толкуется в пользу человека, а не собеседника.
    mockKvBroken = true;
    expect(await readReceiptsAllowed()).toBe(false);
  });

  it('решение своё у каждого аккаунта', async () => {
    await privacyPrefSet('privacy_disable_read_receipts', 'true');
    mockActiveProfileId = 2;
    expect(await readReceiptsAllowed()).toBe(true);
  });
});
