/**
 * Выбор сессии живой геолокации и полоса «остановить» (v4.32.524).
 *
 * Дефект, который здесь закрепляется: номер запущенной сессии хранился только
 * в состоянии экрана. ChatThreadView пересоздаётся на каждого собеседника —
 * значит, выход из переписки или переход к другому человеку стирал номер, а
 * сессия в реестре liveLocationService продолжала жить и слать координаты
 * каждые полминуты до восьми часов. Кнопки остановки у человека не
 * оставалось. Реестр переживает размонтирование, экран — нет, и мост между
 * ними лежит здесь.
 */
import fs from 'fs';
import path from 'path';

import {
  pickLiveLocSession,
  liveLocBannerFor,
  type LiveLocSessionView,
} from '../liveLocSelect';

const NOW = 1_700_000_000_000;

function session(over: Partial<LiveLocSessionView> = {}): LiveLocSessionView {
  return {
    liveId: 'live-1',
    peerPubB64: 'peer-A',
    groupId: null,
    expireAt: NOW + 60_000,
    ...over,
  };
}

describe('выбор сессии по адресу', () => {
  it('своя переписка находится', () => {
    const s = session();
    expect(pickLiveLocSession([s], { peerPubB64: 'peer-A' }, NOW)).toBe(s);
  });

  it('чужая переписка не находится', () => {
    expect(pickLiveLocSession([session()], { peerPubB64: 'peer-B' }, NOW)).toBeNull();
  });

  it('пустой реестр — ничего', () => {
    expect(pickLiveLocSession([], { peerPubB64: 'peer-A' }, NOW)).toBeNull();
  });

  it('истёкшая сессия не считается живой', () => {
    const s = session({ expireAt: NOW });
    expect(pickLiveLocSession([s], { peerPubB64: 'peer-A' }, NOW)).toBeNull();
    expect(pickLiveLocSession([s], { peerPubB64: 'peer-A' }, NOW - 1)).toBe(s);
  });

  it('групповая сессия находится по группе', () => {
    const s = session({ peerPubB64: '', groupId: 'g1' });
    expect(pickLiveLocSession([s], { peerPubB64: '', groupId: 'g1' }, NOW)).toBe(s);
  });

  it('групповая сессия не подставляется под личную переписку', () => {
    // У сессии в группе peerPubB64 пустой. Если искать по собеседнику без
    // отдельной ветки, пустой ключ совпал бы с пустым — и экран переписки
    // показал бы полосу от чужой групповой трансляции.
    const s = session({ peerPubB64: '', groupId: 'g1' });
    expect(pickLiveLocSession([s], { peerPubB64: '' }, NOW)).toBeNull();
  });

  it('личная сессия не подставляется под группу', () => {
    expect(pickLiveLocSession([session()], { peerPubB64: 'peer-A', groupId: 'g1' }, NOW)).toBeNull();
  });

  it('groupId со значением null равнозначен его отсутствию', () => {
    const s = session();
    expect(pickLiveLocSession([s], { peerPubB64: 'peer-A', groupId: null }, NOW)).toBe(s);
  });

  it('из нескольких сессий берётся нужная', () => {
    const mine = session({ liveId: 'live-2', peerPubB64: 'peer-B' });
    const rows = [session(), mine, session({ liveId: 'live-3', peerPubB64: '', groupId: 'g1' })];
    expect(pickLiveLocSession(rows, { peerPubB64: 'peer-B' }, NOW)).toBe(mine);
  });

  it('истёкшая своя не заслоняет живую свою', () => {
    const dead = session({ liveId: 'dead', expireAt: NOW - 1 });
    const live = session({ liveId: 'live' });
    expect(pickLiveLocSession([dead, live], { peerPubB64: 'peer-A' }, NOW)).toBe(live);
  });
});

describe('полоса «остановить»', () => {
  it('нет сессии — нет полосы', () => {
    expect(liveLocBannerFor(null, NOW)).toBeNull();
    expect(liveLocBannerFor(undefined, NOW)).toBeNull();
  });

  it('живая сессия даёт номер и срок', () => {
    expect(liveLocBannerFor(session({ expireAt: NOW + 5_000 }), NOW)).toEqual({
      liveId: 'live-1',
      clearAfterMs: 5_000,
    });
  });

  it('истёкшая сессия полосы не даёт', () => {
    expect(liveLocBannerFor(session({ expireAt: NOW }), NOW)).toBeNull();
    expect(liveLocBannerFor(session({ expireAt: NOW - 1 }), NOW)).toBeNull();
  });

  it('срок всегда положительный — таймер с нулём сработал бы сразу', () => {
    for (const dt of [1, 1_000, 8 * 60 * 60_000]) {
      const b = liveLocBannerFor(session({ expireAt: NOW + dt }), NOW);
      expect(b).not.toBeNull();
      expect(b!.clearAfterMs).toBeGreaterThan(0);
    }
  });
});

describe('исходники', () => {
  const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'liveLocationService.ts'), 'utf8');
  const CHAT = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx'),
    'utf8',
  );

  it('модуль выбора ничего не импортирует', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'liveLocSelect.ts'), 'utf8');
    expect(src).not.toMatch(/^import /m);
  });

  it('сервис берёт выбор из общего модуля, а не повторяет его', () => {
    expect(SERVICE).toContain("from './liveLocSelect'");
    expect(SERVICE).toContain('return pickLiveLocSession(activeSessions.values()');
  });

  it('экран спрашивает реестр при входе', () => {
    expect(CHAT).toContain('liveLocBannerFor(getActiveLiveLoc(peerB64), Date.now())');
    // Полосу убирает собственный таймер экрана: onExpire замкнут на прошлое
    // монтирование и до нынешнего не дотянется.
    expect(CHAT).toContain('banner.clearAfterMs');
  });

  it('обработчик посылки берёт номер из неё самой, а не ждёт возврата', () => {
    expect(CHAT).toContain('id: payload.liveId');
    expect(CHAT).toContain('cid: `live:${payload.liveId}`');
    expect(CHAT).not.toContain('let liveId: string | null = null;');
  });

  it('сервис не подгружает профиль и координаты на лету', () => {
    // Оба импорта были динамическими и стояли внутри общего try/catch: осечка
    // загрузки молча выключала защиту от смены профиля и превращала отправку
    // в строчку журнала. Проверить путь отправки было нельзя вовсе.
    expect(SERVICE).not.toContain("await import('expo-location')");
    expect(SERVICE).not.toContain("await import('../identity/profileManager')");
    expect(SERVICE).toContain("import { profileManager } from '../identity/profileManager';");
    expect(SERVICE).toContain("import { readCurrentPosition } from './deviceLocation';");
  });

  it('флаг остановки живёт на записи сессии, а не в замыкании', () => {
    expect(SERVICE).toContain('session.stopped');
    expect(SERVICE).not.toContain('let stopped = false;');
    // Реестр пополняется до первой отправки, а не последней строкой запуска.
    expect(SERVICE).toContain('activeSessions.set(liveId, session);');
    expect(SERVICE).toContain('if (session.stopped) return liveId;');
  });
});
