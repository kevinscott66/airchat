/**
 * О переходе на прямой трафик человеку говорят — и говорят один раз.
 *
 * Политика туннеля — fail-open, и она осознанная. Проверяется здесь не она, а
 * то, что fail-open перестал быть тихим: до этой правки единственным
 * подписчиком на переподъём был экран настроек OpenFlux, то есть человек
 * узнавал о прямом трафике, только если этот экран открыт в ту самую секунду.
 */
import {
  openFluxNoticeText,
  startOpenFluxDegradedNotice,
} from '../openFluxDegradedNotice';
import { addToastListener, resetNotifyBus, type ToastSpec } from '../components/appNotify';

/**
 * Сторож подменён: проверяется реакция на его сообщение, а не он сам. Имя с
 * `mock` — требование babel-plugin-jest-hoist: фабрика `jest.mock` поднимается
 * выше объявлений, и обращаться она может только к таким именам.
 */
let mockFire: ((r: unknown) => void) | null = null;

jest.mock('../../core/vpn/openFluxNetworkGuard', () => ({
  addOpenFluxReviveListener: (fn: (r: unknown) => void) => {
    mockFire = fn;
    return () => {
      mockFire = null;
    };
  },
}));

/** Сказать подписчику, чем кончился заход сторожа. */
function notify(r: Revived): void {
  if (!mockFire) throw new Error('никто не подписан на сторожа');
  mockFire(r);
}

type Revived = {
  status: 'on' | 'failed' | 'off' | 'starting' | 'unsupported' | 'unconfigured';
  socks: string | null;
  transport: 'restarted' | 'failed';
};

const ok: Revived = { status: 'on', socks: '127.0.0.1:1080', transport: 'restarted' };
const coreDown: Revived = { status: 'failed', socks: null, transport: 'restarted' };
const noLink: Revived = { status: 'on', socks: '127.0.0.1:1080', transport: 'failed' };

describe('текст уведомления', () => {
  it('всё поднялось — молчим', () => {
    expect(openFluxNoticeText(ok)).toBeNull();
  });

  it('ядро не поднялось — связь есть, туннеля нет', () => {
    const text = openFluxNoticeText(coreDown);
    expect(text).toContain('напрямую');
    // Идти никуда не надо: чинить человеку тут нечего.
    expect(text).not.toContain('настройки');
  });

  it('соединение не переоткрылось — связи нет вовсе', () => {
    // Единственный случай, когда поход в настройки имеет смысл, — и текст
    // обязан отличаться от предыдущего, иначе человек не поймёт, что дело не в
    // туннеле, а в том, что у него не работает вообще ничего.
    const text = openFluxNoticeText(noLink);
    expect(text).toContain('настройки');
    expect(text).not.toBe(openFluxNoticeText(coreDown));
  });

  it('обрыв связи важнее отсутствия туннеля', () => {
    // Оба отказа сразу: сказать надо про тот, который человек сейчас ощущает.
    expect(openFluxNoticeText({ status: 'failed', socks: null, transport: 'failed' })).toBe(
      openFluxNoticeText(noLink),
    );
  });
});

describe('показ уведомления', () => {
  let seen: ToastSpec[] = [];
  let stop: (() => void) | null = null;

  beforeEach(() => {
    resetNotifyBus();
    seen = [];
    addToastListener((s) => seen.push(s));
    stop = startOpenFluxDegradedNotice();
  });

  afterEach(() => {
    stop?.();
    stop = null;
    resetNotifyBus();
  });

  it('удачный заход проходит молча', () => {
    notify(ok);
    expect(seen).toEqual([]);
  });

  it('о неудаче говорят', () => {
    notify(coreDown);
    expect(seen).toHaveLength(1);
    expect(seen[0].tone).toBe('error');
    expect(seen[0].message).toBe(openFluxNoticeText(coreDown));
  });

  it('о той же неудаче подряд не говорят дважды', () => {
    // В метро и в лифте сеть переключается пять раз подряд, и туннель падает на
    // каждом переключении. Пять одинаковых тостов — это не информирование.
    notify(coreDown);
    notify(coreDown);
    notify(coreDown);
    expect(seen).toHaveLength(1);
  });

  it('после удачного захода о новой поломке скажут снова', () => {
    notify(coreDown);
    notify(ok);
    notify(coreDown);
    expect(seen).toHaveLength(2);
  });
});
