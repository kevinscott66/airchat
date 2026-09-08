/**
 * v4.32.656: решение «кто видит, когда я в сети» не переходит между аккаунтами.
 *
 * Настройка «время последнего входа» живёт в presenceService в одном
 * экземпляре на весь процесс: myVisibility плюс myVisibilityKnown — «мы её
 * уже прочитали». Второй флаг завели в v4.32.475 ровно затем, чтобы отказ
 * базы не читался как разрешающее 'everybody'. Но принадлежит эта память
 * ОДНОМУ профилю — тому, под которым служба поднята, — а обращались с ней
 * как с общей.
 *
 * Что получалось до этой версии:
 *   - остановка службы при смене аккаунта чистила hiddenPeersKnown и не
 *     трогала myVisibilityKnown: решение прошлого владельца телефона
 *     продолжало отвечать за нового, пока его собственную настройку не
 *     успели прочитать. Безопасный путь (loadPersistedPresence) при
 *     переключении может и не добежать, а уборка выполняется всегда;
 *   - рассылка просьб (presencePrefSync.currentVisibility) при отказе чтения
 *     брала запасное решение из той же памяти и писала туда своё — от имени
 *     любого номера, какой в этот момент активен. Настройка одного аккаунта
 *     отвечала за рассылку другого, и в обе стороны.
 *
 * Отменить разосланное «показывайте моё время» нельзя, не разослать — можно:
 * чужому номеру достаётся осторожное 'nobody'.
 */

const mockKv = new Map<string, string>();
/** Ответ privacyPrefTryGetFor: null — «не прочиталось». */
let mockPrefRead: { value: string | null } | null = { value: 'everybody' };
let mockActivePid = 1;
const mockSent: Array<{ peer: string; text: string }> = [];
const mockPeer = 'собеседникПервый==';

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvSetChecked: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvDelete: async (k: string) => { mockKv.delete(k); },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: mockActivePid, name: 'Аккаунт', did: 'did:key:z1' }),
    getAllProfiles: () => [
      { id: 1, name: 'Личный', did: 'did:key:z1' },
      { id: 2, name: 'Рабочий', did: 'did:key:z2' },
    ],
  },
}));

jest.mock('../../identity/ownProfile', () => ({ ownFieldGetFor: async () => '' }));
jest.mock('../../identity/ownerPidLookup', () => ({ ownerPidForPublicKeyB64: () => null }));
jest.mock('../../transport/ipfs/pubsub', () => ({ pubsubPublish: async () => null, pubsubSubscribe: async () => null }));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => false }));
jest.mock('../contacts', () => ({
  listContacts: async () => [],
  listContactsFor: async () => [{ peerPublicKey: mockPeer }],
}));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryGet: async () => mockPrefRead,
  privacyPrefTryGetFor: async () => mockPrefRead,
}));
jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: async (peer: string, text: string) => { mockSent.push({ peer, text }); },
  }),
}));
jest.mock('../sendGate', () => ({ canReachPeer: async () => true }));
jest.mock('../controlWatermark', () => ({ acceptControlTs: async () => true }));
jest.mock('../../logger', () => ({ log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } }));
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }), currentState: 'active' } }));

import {
  loadPersistedPresence,
  setMyLastSeenVisibility,
  effectiveMyLastSeenVisibility,
  presenceOwnerPid,
  stopPresenceBroadcast,
} from '../presenceService';
import { broadcastLastSeenPref } from '../presencePrefSync';
import { decodePresencePrefEnvelope } from '../presenceEnvelope';

beforeEach(async () => {
  await stopPresenceBroadcast();
  mockKv.clear();
  mockSent.length = 0;
  mockActivePid = 1;
  mockPrefRead = { value: 'everybody' };
});

describe('повод для правки жив', () => {
  it('память решения одна на процесс, и её делят аккаунты', async () => {
    await loadPersistedPresence([], 1);
    // ПРОВЕРКА НЕ ПУСТАЯ: служба поднята под первым номером и решение помнит.
    expect(presenceOwnerPid()).toBe(1);
    setMyLastSeenVisibility('everybody');
    expect(effectiveMyLastSeenVisibility()).toBe('everybody');
  });
});

describe('смена аккаунта уносит решение с собой', () => {
  it('остановка службы забывает «кто видит моё время входа»', async () => {
    await loadPersistedPresence([], 1);
    setMyLastSeenVisibility('everybody');
    // ПРОВЕРКА НЕ ПУСТАЯ: до остановки решение действует.
    expect(effectiveMyLastSeenVisibility()).toBe('everybody');
    await stopPresenceBroadcast();
    // После — «не знаем», а «не знаем» значит 'nobody'. Следующий такт
    // рассылки перечитает настройку нового владельца сам.
    expect(effectiveMyLastSeenVisibility()).toBe('nobody');
  });

  it('рассылка чужого номера не берёт запасное решение из памяти службы', async () => {
    await loadPersistedPresence([], 1);
    setMyLastSeenVisibility('everybody');
    // Активен уже второй аккаунт, а служба всё ещё поднята под первым.
    mockActivePid = 2;
    mockPrefRead = null; // настройка второго не прочиталась
    await broadcastLastSeenPref();
    // ПРОВЕРКА НЕ ПУСТАЯ: адресат один и просьба до него дошла.
    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].peer).toBe(mockPeer);
    // 'everybody' первого аккаунта не отвечает за второй: осторожное «нет».
    expect(decodePresencePrefEnvelope(mockSent[0].text)?.show).toBe(false);
  });

  it('рассылка чужого номера не пишет своё решение в память службы', async () => {
    await loadPersistedPresence([], 1);
    setMyLastSeenVisibility('nobody');
    expect(effectiveMyLastSeenVisibility()).toBe('nobody');
    mockActivePid = 2;
    mockPrefRead = { value: 'everybody' }; // настройка ВТОРОГО аккаунта
    await broadcastLastSeenPref();
    // ПРОВЕРКА НЕ ПУСТАЯ: рассылка прошла и шла именно по настройке второго.
    expect(mockSent).toHaveLength(1);
    expect(decodePresencePrefEnvelope(mockSent[0].text)?.show).toBe(true);
    // А память первого осталась нетронутой: обратное направление той же течи.
    expect(effectiveMyLastSeenVisibility()).toBe('nobody');
  });

  it('своим номером служба по-прежнему пользуется памятью', async () => {
    await loadPersistedPresence([], 1);
    setMyLastSeenVisibility('everybody');
    mockActivePid = 1; // тот же номер, под которым поднята служба
    mockPrefRead = null; // и настройка не прочиталась
    await broadcastLastSeenPref();
    // Здесь запасное решение законно: это тот же аккаунт.
    expect(mockSent).toHaveLength(1);
    expect(decodePresencePrefEnvelope(mockSent[0].text)?.show).toBe(true);
  });
});
