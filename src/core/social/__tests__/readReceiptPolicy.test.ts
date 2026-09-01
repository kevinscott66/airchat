/**
 * «Не отправлять отметки о прочтении» — переключатель против отправки (v4.32.312).
 *
 * Человек выключает его затем, чтобы не сообщать, когда именно он читает. До
 * этой версии переключатель закрывал только личные переписки, а в группах
 * отметки продолжали уходить — и складывались в `seen_by`, список «кто видел» с
 * временем, который видят остальные участники. То есть настройка обещала
 * молчание, а тишины не давала.
 *
 * Проверка живёт внутри самой отправки, а не у вызывающего: групповые отметки
 * рассылаются циклом по отправителям последних сообщений, и следующий вызов,
 * добавленный где-нибудь ещё, про настройку бы не вспомнил.
 */
const mockSendMessage = jest.fn(async (_peer: string, _text: string) => {});
// v4.32.465: разрешение спрашивают у того профиля, чьим ключом отметка будет
// подписана, — служба переписки называет его сама.
const MY_PID = 7;
jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: mockSendMessage,
    groupRecipient: async () => ({
      pid: 7,
      pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      myPub: 'MYpub',
    }),
  }),
}));

let mockAllowed = true;
const mockReadReceiptsAllowedFor = jest.fn(async (_pid: number) => mockAllowed);
jest.mock('../../settings/privacyPrefs', () => ({
  readReceiptsAllowedFor: (pid: number) => mockReadReceiptsAllowedFor(pid),
  privacyPrefBoolFor: jest.fn(async () => false),
}));

jest.mock('../../identity/profileManager', () => ({ profileManager: {} }));
jest.mock('../../identity/ownProfile', () => ({ getOwnDisplayName: async () => 'me' }));
jest.mock('../../crypto/keyManager', () => ({ loadKeyPair: async () => null }));
jest.mock('../../storage/local', () => ({}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { sendGroupReadReceipt } from '../groupMessaging';

const GROUP = 'g-abcdef0123';
const SENDER = 'SENDERpub';
const ME = 'MYpub';

beforeEach(() => {
  mockSendMessage.mockClear();
  mockReadReceiptsAllowedFor.mockClear();
  mockAllowed = true;
});

describe('отметки о прочтении в группе', () => {
  it('уходят, пока переключатель не тронут', async () => {
    await sendGroupReadReceipt(GROUP, 'm1', SENDER, ME);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0]?.[0]).toBe(SENDER);
  });

  it('разрешение спрашивают у профиля, чьим ключом отметка уйдёт', async () => {
    // Не у активного: человек мог за это время переключить аккаунт.
    await sendGroupReadReceipt(GROUP, 'm1', SENDER, ME);
    expect(mockReadReceiptsAllowedFor).toHaveBeenCalledWith(MY_PID);
  });

  it('не уходят при включённой настройке', async () => {
    // Ровно то, чего не было до v4.32.312: выключатель молчал только про личные
    // переписки, а участники группы всё так же видели время прочтения.
    mockAllowed = false;
    await sendGroupReadReceipt(GROUP, 'm1', SENDER, ME);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('себе не отправляются', async () => {
    await sendGroupReadReceipt(GROUP, 'm1', ME, ME);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('в конверте только id последнего увиденного, без текста', async () => {
    // Отметка — служебное сообщение; попади в неё содержимое, настройка про
    // «когда я читаю» превратилась бы в утечку «что я читаю».
    await sendGroupReadReceipt(GROUP, 'm42', SENDER, ME);
    const payload = String(mockSendMessage.mock.calls[0]?.[1]);
    const env = JSON.parse(payload.slice(payload.indexOf('{'))) as Record<string, unknown>;
    expect(env.groupId).toBe(GROUP);
    expect(env.lastSeenMsgId).toBe('m42');
    expect(env.viewerPubB64).toBe(ME);
    expect(Object.keys(env).sort()).toEqual(['groupId', 'lastSeenMsgId', 'ts', 'viewerPubB64']);
  });
});
