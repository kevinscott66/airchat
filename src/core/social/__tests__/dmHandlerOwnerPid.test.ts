/**
 * Обработчики входящих личных конвертов пишут в профиль ВЛАДЕЛЬЦА (v4.32.481).
 *
 * Служба переписки создаётся под конкретную пару ключей и знает свой номер
 * профиля точно (ownerProfileId). Обработчики закрепления, автоудаления,
 * реакции, опроса, сторис и профиля контакта раньше выясняли его сами —
 * чтением глобального «активного». Между расшифровкой конверта и записью в
 * базу стоят await'ы: переключение аккаунта помещается туда целиком, и
 * пришедшее личным сообщением ложилось в переписку другого профиля.
 *
 * Здесь активный профиль намеренно НЕ совпадает с владельцем: всё, что
 * записывается, обязано уйти во владельца.
 */

const mockSetPinned = jest.fn<Promise<void>, [string, number, string | null]>(async () => {});
const mockSetTimer = jest.fn<Promise<void>, [string, number, number]>(async () => {});
const mockSaveMsg = jest.fn<Promise<void>, [Record<string, unknown>]>(async () => {});
const mockTexts = jest.fn<Promise<Map<string, string>>, [string[], string, number]>(
  async (ids) => new Map(ids.map((id) => [id, 'текст']))
);
const mockKv = new Map<string, string>();

jest.mock('../../storage/local', () => ({
  kvGet: async (k: string) => mockKv.get(k) ?? null,
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  // v4.32.484: закрепления читаются через profileScopedKv — ему нужны эти два.
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvDelete: async (k: string) => { mockKv.delete(k); },
  setConversationPinnedMessage: (...a: [string, number, string | null]) => mockSetPinned(...a),
  setConversationDisappearTimer: (...a: [string, number, number]) => mockSetTimer(...a),
  getChatMessageTexts: (...a: [string[], string, number]) => mockTexts(...a),
  saveChatMessage: (...a: [Record<string, unknown>]) => mockSaveMsg(...a),
  notifyChatStorageChanged: () => {},
}));

// Активный профиль — ЧУЖОЙ: 7, а владелец конверта — 3.
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 7, name: 'Рабочий' }) },
}));

jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
  fanoutReasonText: () => '',
}));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import * as fs from 'fs';
import * as path from 'path';
import { encodeDmPinEnvelope, handleIncomingDmPin } from '../dmPinSync';
import { encodeDisappearEnvelope, handleIncomingDisappear } from '../disappearSync';

const OWNER = 3;
const PEER = 'peerPub====';

function src(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
}

beforeEach(() => {
  mockKv.clear();
  mockSetPinned.mockClear();
  mockSetTimer.mockClear();
  mockSaveMsg.mockClear();
  mockTexts.mockClear();
});

describe('закрепление в личке', () => {
  it('пишет закрепление владельцу, а не активному профилю', async () => {
    const env = encodeDmPinEnvelope({ msgId: 'm1', on: true, ts: 1000 });
    expect(await handleIncomingDmPin(env, PEER, OWNER)).toBe(true);
    expect(mockSetPinned).toHaveBeenCalledWith(PEER, OWNER, 'm1');
  });

  it('тексты закреплённых читает из переписки владельца', async () => {
    const env = encodeDmPinEnvelope({ msgId: 'm1', on: true, ts: 1000 });
    await handleIncomingDmPin(env, PEER, OWNER);
    expect(mockTexts).toHaveBeenCalledWith(['m1'], PEER, OWNER);
  });

  it('«открепить всё» тоже адресовано владельцу', async () => {
    const env = encodeDmPinEnvelope({ msgId: '', on: false, ts: 1000, all: true });
    expect(await handleIncomingDmPin(env, PEER, OWNER)).toBe(true);
    expect(mockSetPinned).toHaveBeenCalledWith(PEER, OWNER, null);
  });

  it('чужой префикс не трогает базу', async () => {
    expect(await handleIncomingDmPin('обычный текст', PEER, OWNER)).toBe(false);
    expect(mockSetPinned).not.toHaveBeenCalled();
  });

  it('конверт без отправителя не применяется', async () => {
    const env = encodeDmPinEnvelope({ msgId: 'm1', on: true, ts: 1000 });
    expect(await handleIncomingDmPin(env, undefined, OWNER)).toBe(true);
    expect(mockSetPinned).not.toHaveBeenCalled();
  });
});

describe('таймер исчезающих сообщений', () => {
  it('ставится в переписке владельца', async () => {
    const env = encodeDisappearEnvelope({ ms: 60_000, ts: 2000 });
    expect(await handleIncomingDisappear(env, PEER, OWNER)).toBe(true);
    expect(mockSetTimer).toHaveBeenCalledWith(PEER, OWNER, 60_000);
  });

  it('системная строка ложится в переписку владельца', async () => {
    const env = encodeDisappearEnvelope({ ms: 60_000, ts: 2000 });
    await handleIncomingDisappear(env, PEER, OWNER);
    expect(mockSaveMsg).toHaveBeenCalled();
    const row = mockSaveMsg.mock.calls[0][0] as { ownerProfileId?: number };
    expect(row.ownerProfileId).toBe(OWNER);
  });

  it('конверт без отправителя не ставит таймер', async () => {
    const env = encodeDisappearEnvelope({ ms: 60_000, ts: 2000 });
    expect(await handleIncomingDisappear(env, undefined, OWNER)).toBe(true);
    expect(mockSetTimer).not.toHaveBeenCalled();
  });
});

describe('форма исходников', () => {
  const HANDLERS: [string, string][] = [
    ['reactionSync.ts', 'handleIncomingReaction'],
    ['pollVoteSync.ts', 'handleIncomingPollVote'],
    ['pollVoteSync.ts', 'handleIncomingPollClose'],
    ['dmPinSync.ts', 'handleIncomingDmPin'],
    ['disappearSync.ts', 'handleIncomingDisappear'],
    ['profileSync.ts', 'handleIncomingPeerProfile'],
    ['storyService.ts', 'handleIncomingStory'],
  ];

  it.each(HANDLERS)('%s: %s принимает профиль-владелец параметром', (file, fn) => {
    const s = src(file);
    const at = s.indexOf(`export async function ${fn}(`);
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(at, at + 220)).toContain('ownerPid: number');
  });

  it.each([
    ['reactionSync.ts'],
    ['pollVoteSync.ts'],
    ['dmPinSync.ts'],
    ['disappearSync.ts'],
  ])('%s: обработчик не спрашивает активный профиль', (file) => {
    const s = src(file);
    for (const fn of ['handleIncoming']) {
      const parts = s.split(`export async function ${fn}`).slice(1);
      for (const part of parts) {
        const body = part.slice(0, part.indexOf('\n}\n') + 1 || part.length);
        expect(body).not.toContain('profileManager.getActiveProfile()');
      }
    }
  });

  it('messaging передаёт ownerPid каждому обработчику личных конвертов', () => {
    const s = src('messaging.ts');
    for (const fn of [
      'handleIncomingStory',
      'handleIncomingReaction',
      'handleIncomingPollVote',
      'handleIncomingPollClose',
      'handleIncomingDmPin',
      'handleIncomingDisappear',
      'handleIncomingPeerProfile',
    ]) {
      expect(s).toContain(`await ${fn}(textPayload.text, peerPubKeyB64, ownerPid);`);
    }
  });

  it('профиль контакта записывается в названный профиль', () => {
    // v4.32.547: к конверту добавляется результат проверки бумаги на галочку,
    // но адресат записи прежний — именно ownerPid, а не активный профиль.
    expect(src('profileSync.ts')).toContain('await setPeerProfileFor(ownerPid, senderPubB64, {');
    expect(src('contacts.ts')).toContain('export async function setPeerProfileFor(\n  pid: number,');
  });

  it('сторис берёт профиль из своей пары ключей, а не из активного', () => {
    // v4.32.482: проводка «профиль по ключу» переехала в ownerPidLookup —
    // она была нужна ещё и presence, а третьей копии этого правила не будет.
    const s = src('storyService.ts');
    expect(s).toContain("import { ownerPidForPublicKey } from '../identity/ownerPidLookup';");
    expect(s).toContain('const pid = ownerPidForPublicKey(pair.publicKey);');
    expect(s).toContain('const contacts = await listContactsFor(pid);');
    expect(s).not.toContain('await listContacts()');
  });

  it('проверка не пустая', () => {
    expect(src('dmPinSync.ts')).toContain('handleIncomingDmPin');
  });
});
