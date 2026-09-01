/**
 * Заглушение личной переписки и имя ключа под ним (v4.32.510).
 *
 * Дефект: экраны глушили собеседника по открытому ключу в base64, а все три
 * читателя — баннер при открытом приложении, фоновый обработчик push и лента —
 * спрашивали по did:key. Два разных имени ключа, совпасть не способных: значок
 * «без звука» горел, а уведомления шли все до единого.
 *
 * Проверяется не приведение само по себе, а стык: что записанное экраном
 * находится и тем, кто собирает имя ключа так, как это делает фоновый
 * обработчик, — то есть из did и без единого обращения к слою хранилища.
 */
const mockKv = new Map<string, string>();
let mockActiveId = 1;

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveId }) },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { getMuteState, isMuted, listMuted, setMuted, sweepExpiredMutes, unmute } from '../muteStore';
import { canonicalMuteId, isCanonicalMuteId } from '../muteChatId';
import { isMuteActive, muteKey } from '../muteValue';
import { profileScopedKey } from '../../storage/kvKeys';
import { didFromPubB64 } from '../../identity/did';

const SRC = path.join(__dirname, '..', '..', '..');

const PEER = 'P'.repeat(43);
const PEER_DID = didFromPubB64(PEER) as string;
const OTHER = 'Q'.repeat(43);
const OTHER_DID = didFromPubB64(OTHER) as string;
const GROUP = 'g-shared';
const HOUR = 60 * 60 * 1000;

/**
 * Имя ключа ровно так, как его собирает фоновый обработчик push: из did, через
 * muteValue, без слоя хранилища. Копия здесь намеренная — если общее правило
 * разъедется с ней, тест обязан упасть.
 */
function backgroundKey(pid: number, contactDid: string): string {
  return profileScopedKey(pid, muteKey('chat', contactDid));
}

beforeEach(() => {
  mockKv.clear();
  mockActiveId = 1;
  jest.clearAllMocks();
});

describe('canonicalMuteId', () => {
  test('открытый ключ переписки приводится к did:key', () => {
    expect(canonicalMuteId('chat', PEER)).toBe(PEER_DID);
    expect(PEER_DID.startsWith('did:key:z')).toBe(true);
  });

  test('did:key уже канонический и не трогается', () => {
    expect(canonicalMuteId('chat', PEER_DID)).toBe(PEER_DID);
    expect(isCanonicalMuteId('chat', PEER_DID)).toBe(true);
  });

  test('две формы одной личности дают одно имя', () => {
    expect(canonicalMuteId('chat', PEER)).toBe(canonicalMuteId('chat', PEER_DID));
  });

  test('разные люди не схлопываются в одно имя', () => {
    expect(canonicalMuteId('chat', PEER)).not.toBe(canonicalMuteId('chat', OTHER));
  });

  test('то, что ключом не является, возвращается как есть — запись не теряется', () => {
    expect(canonicalMuteId('chat', 'не-ключ')).toBe('не-ключ');
    expect(canonicalMuteId('chat', '')).toBe('');
    // Короче ключа на один символ: publicKeyFromB64 такое отвергает, и
    // придумывать did мы не вправе.
    expect(canonicalMuteId('chat', 'A'.repeat(42))).toBe('A'.repeat(42));
  });

  test('группы, каналы и публикации не трогаются', () => {
    for (const kind of ['group', 'channel', 'post'] as const) {
      expect(canonicalMuteId(kind, GROUP)).toBe(GROUP);
      // Даже если id внешне похож на ключ: у групп обе стороны всегда
      // передавали собственный id, и второй формы у него нет.
      expect(canonicalMuteId(kind, PEER)).toBe(PEER);
    }
  });
});

describe('стык записи и чтения — тот самый дефект', () => {
  test('заглушённый по открытому ключу находится по did:key', async () => {
    await setMuted('chat', PEER);
    expect(await isMuted('chat', PEER_DID)).toBe(true);
  });

  test('и наоборот: заглушённый по did:key находится по открытому ключу', async () => {
    await setMuted('chat', PEER_DID);
    expect(await isMuted('chat', PEER)).toBe(true);
  });

  test('фоновый обработчик push видит запись, сделанную экраном', async () => {
    mockActiveId = 3;
    await setMuted('chat', PEER);
    expect(isMuteActive(mockKv.get(backgroundKey(3, PEER_DID)), Date.now())).toBe(true);
  });

  test('отсрочка доезжает до фонового обработчика вместе со сроком', async () => {
    const until = Date.now() + HOUR;
    await setMuted('chat', PEER, { untilMs: until });
    const raw = mockKv.get(backgroundKey(1, PEER_DID));
    expect(isMuteActive(raw, Date.now())).toBe(true);
    expect(isMuteActive(raw, until + 1)).toBe(false);
  });

  test('незаглушённый собеседник фоновым обработчиком не глушится', async () => {
    await setMuted('chat', PEER);
    expect(isMuteActive(mockKv.get(backgroundKey(1, OTHER_DID)), Date.now())).toBe(false);
  });

  test('снятие по открытому ключу видно и по did:key', async () => {
    await setMuted('chat', PEER);
    await unmute('chat', PEER);
    expect(await isMuted('chat', PEER_DID)).toBe(false);
    expect(mockKv.size).toBe(0);
  });

  test('список «Заглушённые» отдаёт did — то же, что снимает заглушение', async () => {
    await setMuted('chat', PEER);
    const list = await listMuted('chat');
    expect(list.map((e) => e.id)).toEqual([PEER_DID]);
    await unmute('chat', list[0].id);
    expect(await isMuted('chat', PEER)).toBe(false);
  });
});

describe('записи прежней сборки', () => {
  test('уборка переносит их под каноническое имя, и заглушение оживает', async () => {
    mockKv.set(`p1:mute:chat:${PEER}`, '1');
    expect(await isMuted('chat', PEER_DID)).toBe(false);
    expect(await sweepExpiredMutes()).toEqual({ removed: 0, migrated: 1 });
    expect(await isMuted('chat', PEER_DID)).toBe(true);
    expect(mockKv.has(`p1:mute:chat:${PEER}`)).toBe(false);
  });

  test('срок при переносе сохраняется', async () => {
    const until = Date.now() + HOUR;
    mockKv.set(`p1:mute:chat:${PEER}`, `until:${until}`);
    await sweepExpiredMutes();
    const state = await getMuteState('chat', PEER_DID);
    expect(state.muted).toBe(true);
    expect(state.untilMs).toBe(until);
  });

  test('истёкшая старая запись убирается, а не переезжает', async () => {
    mockKv.set(`p1:mute:chat:${PEER}`, `until:${Date.now() - 1}`);
    expect(await sweepExpiredMutes()).toEqual({ removed: 1, migrated: 0 });
    expect(mockKv.size).toBe(0);
  });

  test('свежее решение человека переносом не перебивается', async () => {
    await setMuted('chat', PEER, { untilMs: Date.now() + HOUR });
    mockKv.set(`p1:mute:chat:${PEER}`, '1');
    await sweepExpiredMutes();
    const state = await getMuteState('chat', PEER_DID);
    expect(state.untilMs).not.toBeNull();
    expect(mockKv.has(`p1:mute:chat:${PEER}`)).toBe(false);
  });

  test('уборка не трогает группы и публикации', async () => {
    await setMuted('group', GROUP);
    await setMuted('post', 'post-1');
    expect(await sweepExpiredMutes()).toEqual({ removed: 0, migrated: 0 });
    expect(await isMuted('group', GROUP)).toBe(true);
    expect(await isMuted('post', 'post-1')).toBe(true);
  });

  test('старую запись можно снять из «Заглушённых» до всякой уборки', async () => {
    mockKv.set(`p1:mute:chat:${PEER}`, '1');
    const list = await listMuted('chat');
    expect(list.map((e) => e.id)).toEqual([PEER]);
    await unmute('chat', list[0].id);
    expect(mockKv.size).toBe(0);
  });

  test('непонятная старая запись не переезжает и не пропадает', async () => {
    mockKv.set('p1:mute:chat:не-ключ', '1');
    expect(await sweepExpiredMutes()).toEqual({ removed: 0, migrated: 0 });
    expect(mockKv.get('p1:mute:chat:не-ключ')).toBe('1');
  });
});

describe('форма исходников — v4.32.510', () => {
  const store = fs.readFileSync(path.join(SRC, 'core', 'notifications', 'muteStore.ts'), 'utf8');
  const value = fs.readFileSync(path.join(SRC, 'core', 'notifications', 'muteValue.ts'), 'utf8');
  const bg = fs.readFileSync(path.join(SRC, 'notifications', 'backgroundNotifyPrefs.ts'), 'utf8');
  const push = fs.readFileSync(path.join(SRC, 'notifications', 'pushNotifications.ts'), 'utf8');
  const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');

  test('имя ключа собирается в одном месте и через приведение', () => {
    expect(store).toContain('return muteKey(kind, canonicalMuteId(kind, id));');
  });

  test('разбор значения по-прежнему без импортов — его читает фоновый путь', () => {
    expect(value).not.toMatch(/^import\s/m);
    expect(value).not.toContain('require(');
  });

  test('фоновый обработчик собирает имя из did и слой хранилища не тянет', () => {
    expect(bg).toContain("const logical = muteKey('chat', contactDid);");
    expect(bg).not.toContain('muteStore');
    expect(bg).not.toContain('muteChatId');
  });

  test('оба читателя уведомлений спрашивают по did', () => {
    expect(push).toContain("await isMuted('chat', contactDid)");
    expect(app).toContain("await isMuted('chat', ev.authorDid)");
  });

  test('экраны своего приведения не заводят', () => {
    const dirs = [
      path.join(SRC, 'ui', 'screens'),
      path.join(SRC, 'ui', 'components', 'modals', 'chat'),
    ];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue;
        const body = fs.readFileSync(path.join(dir, name), 'utf8');
        if (body.includes('canonicalMuteId') || body.includes("muteKey('chat'")) offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
