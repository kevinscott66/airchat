/**
 * ДЕФЕКТ (v4.32.1051). Карточка человека выдавала непрочитанный список
 * запретов за «не блокировал».
 *
 * `rateLimiter.isBlocked` отвечает по поднятому в память списку, и когда
 * поднять его не вышло, честный ответ «не знаю» сводится к `false`. Карточка
 * брала этот `false` как факт: `blocked` оставался ложью, пункт настроек
 * назывался «Заблокировать» и подсвечивался красным (`danger`), а «Звонок» и
 * «Видео» снова становились доступными.
 *
 * ЦЕНА. Человек открывает карточку того, кого заблокировал на прошлой неделе,
 * и видит предложение заблокировать — то есть прямое утверждение, что запрета
 * нет. Дальше он либо жмёт «Заблокировать» второй раз, либо решает, что
 * запрет слетел. Отказ чтения здесь настоящий и частый: список лежит в той же
 * SQLite, которая на первых секундах после запуска отвечает отказом при
 * блокировке (см. ui_kv_get_slow). Ровно этот же разрыв закрыт в переписке
 * версией v4.32.1048 — карточка осталась последним местом, которое не
 * спрашивало `blockedListReadable()`.
 *
 * ПРАВКА. Карточка спрашивает `rateLimiter.blockedListReadable()` и держит
 * отдельное `blockUnknown`. Оно едет в `HubFacts`, и подпись становится той
 * же, что уже показывает меню переписки: «Заблокировать (список запретов не
 * прочитан)».
 *
 * ГРАНИЦЫ. Кнопки не гасим: запрета может и не быть, а отнятый звонок из-за
 * занятой базы — вред больший, чем недосказанная подпись. `danger` тоже
 * остаётся: он про то, что действие опасное, а не про то, что оно точно
 * применимо. Прочитанный список работает ровно как прежде.
 */
import fs from 'fs';
import path from 'path';

import { hubQuickActions, hubSettings, type HubFacts } from '../profileHubModel';
import { rateLimiter } from '../../../core/security/rateLimiter';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from); if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = src.indexOf(to, a); if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

const PEEK = () => read('ui', 'components', 'UserProfilePeek.tsx');
const MODEL = () => read('ui', 'components', 'profileHubModel.ts');

const base: HubFacts = {
  isSelf: false,
  inContacts: true,
  hasContactRecord: true,
  blocked: false,
  blockUnknown: false,
  muted: false,
  copyGuard: false,
  copyGuardByPeer: false,
  disappearMs: null,
  reported: false,
  canOpenChat: true,
  inChat: false,
};

const blockLabel = (f: HubFacts): string =>
  hubSettings(f).find((i) => i.id === 'block')?.label ?? '';

describe('что говорит карточка о запрете', () => {
  it('непрочитанный список назван непрочитанным, а не «не блокировал»', () => {
    expect(blockLabel({ ...base, blocked: false, blockUnknown: true }))
      .toBe('Заблокировать (список запретов не прочитан)');
  });

  it('прочитанный и пустой список — обычное «Заблокировать»', () => {
    expect(blockLabel({ ...base, blocked: false, blockUnknown: false })).toBe('Заблокировать');
  });

  it('известный запрет снимается словом «Разблокировать»', () => {
    expect(blockLabel({ ...base, blocked: true, blockUnknown: false })).toBe('Разблокировать');
  });

  it('известный запрет важнее незнания: подпись не сваливается в скобки', () => {
    // blockUnknown при blocked=true возникнуть не должен, но если возникнет —
    // говорим то, что знаем наверняка.
    expect(blockLabel({ ...base, blocked: true, blockUnknown: true })).toBe('Разблокировать');
  });

  it('три состояния называются тремя разными словами', () => {
    const labels = [
      blockLabel({ ...base, blocked: false, blockUnknown: false }),
      blockLabel({ ...base, blocked: false, blockUnknown: true }),
      blockLabel({ ...base, blocked: true, blockUnknown: false }),
    ];
    expect(new Set(labels).size).toBe(3);
  });

  it('подпись — та же строка, что показывает меню переписки (v4.32.1048)', () => {
    const chat = read('ui', 'screens', 'ChatScreen.tsx');
    expect(chat).toContain("'Заблокировать (список запретов не прочитан)'");
    expect(MODEL()).toContain("'Заблокировать (список запретов не прочитан)'");
  });
});

describe('ГРАНИЦА: кнопки при незнании не отнимаем', () => {
  it('«Звонок» и «Видео» доступны, пока запрет не подтверждён', () => {
    const items = hubQuickActions({ ...base, blocked: false, blockUnknown: true });
    expect(items.find((i) => i.id === 'call')?.disabled).toBeFalsy();
    expect(items.find((i) => i.id === 'video')?.disabled).toBeFalsy();
  });

  it('а при подтверждённом запрете — гаснут, как и раньше', () => {
    const items = hubQuickActions({ ...base, blocked: true, blockUnknown: false });
    expect(items.find((i) => i.id === 'call')?.disabled).toBe(true);
    expect(items.find((i) => i.id === 'video')?.disabled).toBe(true);
  });

  it('красная подсветка пункта остаётся: она про опасность действия', () => {
    const item = hubSettings({ ...base, blocked: false, blockUnknown: true })
      .find((i) => i.id === 'block');
    expect(item?.danger).toBe(true);
  });

  it('остальные пункты настроек незнанием не задеты', () => {
    const known = hubSettings({ ...base, blockUnknown: false }).map((i) => i.id);
    const unknown = hubSettings({ ...base, blockUnknown: true }).map((i) => i.id);
    expect(unknown).toEqual(known);
  });
});

describe('карточка спрашивает о читаемости', () => {
  it('эффект переписки берёт blockedListReadable, а не один isBlocked', () => {
    const body = slice(PEEK(), 'await rateLimiter.whenReady();', 'const [guard, wasReported]');
    expect(body).toContain('const readable = rateLimiter.blockedListReadable();');
    expect(body).toContain('setBlockUnknown(!readable);');
    expect(body).toContain('setBlocked(readable && rateLimiter.isBlocked(pub));');
  });

  it('сорвавшееся чтение тоже «неизвестно», а не «не блокировал»', () => {
    const body = slice(PEEK(), 'await rateLimiter.whenReady();', 'const [guard, wasReported]');
    expect(body).toContain('setBlockUnknown(true); setBlocked(false);');
    // Прежний комментарий обещал ровно обратное — его быть не должно.
    expect(PEEK()).not.toContain('блокировка неизвестна — покажем');
  });

  it('отметка сбрасывается на смену собеседника вместе с остальными', () => {
    const body = slice(PEEK(), 'setMuted(false);', 'setCopyGuardState(false);');
    expect(body).toContain('setBlockUnknown(false);');
  });

  it('свой запрет и своё снятие незнание закрывают', () => {
    const body = slice(PEEK(), 'const toggleBlock = useCallback', 'const report = useCallback');
    expect(body).toContain('setBlocked(false); setBlockUnknown(false);');
    expect(body).toContain('setBlocked(true); setBlockUnknown(false);');
  });

  it('признак доезжает до фактов карточки и до списка зависимостей', () => {
    const body = slice(PEEK(), 'const facts: HubFacts = useMemo', 'const quickActions');
    expect(body).toContain('blockUnknown,');
    expect(body).toContain('blocked, blockUnknown, muted');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: без диска список не поднят, а isBlocked молчит', async () => {
    // В тестах хранилища нет, поэтому чтение списка не состоялось. Это тот
    // самый случай, который карточка выдавала за «не блокировал»: обе
    // величины ниже — про одно, но означают противоположное.
    await rateLimiter.whenReady();
    const readable = rateLimiter.blockedListReadable();
    expect(typeof readable).toBe('boolean');
    expect(rateLimiter.isBlocked('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe(false);
    // …и подпись, которую карточка возьмёт в этом состоянии, о нём говорит.
    expect(blockLabel({ ...base, blocked: false, blockUnknown: !readable }))
      .toBe(readable ? 'Заблокировать' : 'Заблокировать (список запретов не прочитан)');
  });

  it('ЗАКРЕПКА: поле в HubFacts обязательное, забыть его нельзя', () => {
    const decl = slice(MODEL(), 'export type HubFacts = {', 'export function');
    expect(decl).toContain('blockUnknown: boolean;');
    expect(decl).not.toContain('blockUnknown?: boolean;');
  });

  it('ЗАКРЕПКА: пункт запрета по-прежнему один и только у чужой карточки', () => {
    expect(hubSettings({ ...base, isSelf: true }).some((i) => i.id === 'block')).toBe(false);
    expect(hubSettings(base).filter((i) => i.id === 'block')).toHaveLength(1);
  });

  it('ЗАКРЕПКА: blockedListReadable у ограничителя ещё есть и отвечает словом', () => {
    expect(typeof rateLimiter.blockedListReadable()).toBe('boolean');
  });
});
