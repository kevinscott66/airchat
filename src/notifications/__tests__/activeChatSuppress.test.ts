/**
 * Уведомление о личном сообщении и «открытая переписка» (v4.32.525).
 *
 * Дефект: отметка «этот диалог сейчас открыт» ставилась один раз при
 * монтировании ветки переписки и снималась только при размонтировании. Но
 * вкладки в AirChat не размонтируются — MainTabs держит их под display:none,
 * чтобы переключение табов не пересобирало тяжёлое дерево. Достаточно было
 * один раз открыть диалог и уйти в Ленту, Группы или Настройки, и все
 * уведомления от этого человека молча выбрасывались до перезапуска
 * приложения. Второй половиной того же была свёрнутая программа: экран
 * погашен, никакой переписки не видно, а баннер всё равно подавлялся.
 */
import fs from 'fs';
import path from 'path';

import { shouldSuppressDmBanner, type OpenChatState } from '../activeChatSuppress';

const PEER = 'did:key:zPeerA';

function open(over: Partial<OpenChatState> = {}): OpenChatState {
  return { peerDid: PEER, groupId: null, tab: 'chat', appState: 'active', ...over };
}

describe('переписка открыта прямо сейчас', () => {
  it('баннер о своём же диалоге не показывается', () => {
    expect(shouldSuppressDmBanner(open(), PEER)).toBe(true);
  });

  it('сообщение от другого человека показывается всегда', () => {
    expect(shouldSuppressDmBanner(open(), 'did:key:zPeerB')).toBe(false);
  });
});

describe('уход на другую вкладку возвращает уведомления', () => {
  it.each(['feed', 'groups', 'profile', 'settings'])('вкладка %s — баннер нужен', (tab) => {
    expect(shouldSuppressDmBanner(open({ tab }), PEER)).toBe(false);
  });

  it('вкладка ещё неизвестна — баннер нужен', () => {
    expect(shouldSuppressDmBanner(open({ tab: null }), PEER)).toBe(false);
  });
});

describe('свёрнутая программа', () => {
  it.each(['background', 'inactive', 'unknown', 'extension'])(
    'состояние %s — баннер нужен',
    (appState) => {
      expect(shouldSuppressDmBanner(open({ appState }), PEER)).toBe(false);
    },
  );

  it('состояние неизвестно — баннер нужен', () => {
    expect(shouldSuppressDmBanner(open({ appState: null }), PEER)).toBe(false);
  });
});

describe('пустые значения', () => {
  it('ветка не открыта — подавлять нечего', () => {
    expect(shouldSuppressDmBanner(open({ peerDid: null }), PEER)).toBe(false);
  });

  it('отправитель неизвестен — баннер нужен', () => {
    // Иначе пустая строка совпала бы с пустой отметкой и заглушила бы
    // сообщение от неопознанного отправителя.
    expect(shouldSuppressDmBanner(open({ peerDid: null }), null)).toBe(false);
    expect(shouldSuppressDmBanner(open({ peerDid: null }), undefined)).toBe(false);
    expect(shouldSuppressDmBanner(open({ peerDid: '' }), '')).toBe(false);
  });

  it('сомнение решается в пользу показа: закрыть баннер можно, вернуть — нет', () => {
    const doubtful: OpenChatState[] = [
      open({ tab: null }),
      open({ appState: null }),
      open({ peerDid: null }),
      open({ tab: 'chat', appState: 'background' }),
    ];
    for (const s of doubtful) expect(shouldSuppressDmBanner(s, PEER)).toBe(false);
  });
});

describe('исходники', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const PUSH = fs.readFileSync(path.join(ROOT, 'notifications', 'pushNotifications.ts'), 'utf8');
  const CHAT = fs.readFileSync(path.join(ROOT, 'ui', 'screens', 'ChatScreen.tsx'), 'utf8');
  const APP = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');

  it('решение не размазано: модуль без импортов', () => {
    const src = fs.readFileSync(path.join(ROOT, 'notifications', 'activeChatSuppress.ts'), 'utf8');
    expect(src).not.toMatch(/^import /m);
  });

  it('баннер спрашивает все три источника, а не один', () => {
    // v4.32.560: снимок стал общим на оба подавления — см. openScreenState.
    expect(PUSH).toContain('shouldSuppressDmBanner(openScreenState(), contactDid)');
    expect(PUSH).toContain('tab: activeTabName');
    expect(PUSH).toContain('appState: AppState.currentState');
    // Прежней проверки «совпал собеседник — молчим» больше нет.
    expect(PUSH).not.toContain('contactDid === activeChatPeerDid');
  });

  it('вкладку сообщает MainTabs — из ref её было не достать', () => {
    expect(APP).toContain('useEffect(() => { setActiveTabName(tab); }, [tab]);');
    expect(PUSH).toContain('export function setActiveTabName(');
  });

  it('экран переписки отмечает ветку без оглядки на вкладку', () => {
    const at = CHAT.indexOf('setActiveChatDid(peerDid);');
    expect(at).toBeGreaterThan(0);
    const head = CHAT.slice(at - 400, at);
    expect(head).not.toContain("tabRef.current !== 'chat'");
    expect(CHAT).toContain('return () => { setActiveChatDid(null); };');
  });
});
