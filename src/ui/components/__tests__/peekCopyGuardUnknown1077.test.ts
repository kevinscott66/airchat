/**
 * ДЕФЕКТ (v4.32.1077). Карточка человека выдавала непрочитанный запрет
 * копирования за «Выкл» — и предлагала включить то, что, возможно, уже
 * включено собеседником.
 *
 * Ядро здесь честное с v4.32.655: `copyGuardStateTryFor` отвечает `null`,
 * когда база не ответила, и `isCopyGuarded` на этом `null` переписку
 * ЗАПИРАЕТ — цена лишнего разрешения необратима, а лишнего запрета нет.
 * Экранный же ответ гасил тот же `null` в `{ mine: false, theirs: false }`,
 * и карточка брала это как факт.
 *
 * ЦЕНА. Две разные, и обе настоящие.
 *
 * Первая: подпись «Выкл» — утверждение о настройке безопасности, и оно
 * спорит с самим приложением. Человек читает «копирование разрешено», идёт
 * в переписку, а «Копировать» и «Переслать» из меню пропали: приложение в
 * эту секунду считает переписку закрытой. Выглядит поломкой.
 *
 * Вторая тяжелее. Нажатие на строку разбирает случаи по `copyGuardByPeer`, а
 * он при отказе чтения `false`. Значит живой запрет собеседника молчит:
 * вместо «Запрет включил собеседник» человек получает окно «будет нельзя ни
 * вам, ни собеседнику» и, нажав «Включить», отправляет ему конверт о
 * запрете, которого не собирался ставить.
 *
 * ПРАВКА. Экранный ответ ядра переименован в `copyGuardView` и везёт при себе
 * `unknown`. Мягкость v4.32.655 сохранена буквально — `mine`/`theirs`
 * остаются `false`, переключатель не рисуется включённым, — но молчать
 * перестала: подпись становится «не удалось прочитать», а нажатие говорит,
 * что состояние неизвестно и переписка пока считается закрытой.
 *
 * ГРАНИЦЫ. Прочитанное состояние работает ровно как прежде, все три прежние
 * подписи на месте. Ядро своего решения не меняло: запирает по-прежнему
 * `isCopyGuarded`, и по-прежнему на отказе — «закрыто».
 */
import fs from 'fs';
import path from 'path';

import { hubSettings, type HubFacts } from '../profileHubModel';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const PEEK = codeOnly(read('ui', 'components', 'UserProfilePeek.tsx'));
const GUARD = codeOnly(read('core', 'social', 'copyGuard.ts'));

const base: HubFacts = {
  isSelf: false,
  inContacts: true,
  hasContactRecord: true,
  bookUnknown: false,
  blocked: false,
  blockUnknown: false,
  muted: false,
  copyGuard: false,
  copyGuardByPeer: false,
  copyGuardUnknown: false,
  disappearMs: null,
  convUnknown: false,
  reported: false,
  reportUnknown: false,
  canOpenChat: true,
  inChat: false,
};

const guardValue = (f: HubFacts): string | undefined =>
  hubSettings(f).find((i) => i.id === 'copy_guard')?.value;

describe('непрочитанный запрет назван своим именем', () => {
  it('подпись говорит «не удалось прочитать», а не «Выкл»', () => {
    expect(guardValue({ ...base, copyGuardUnknown: true })).toBe('не удалось прочитать');
  });

  it('незнание сильнее обоих решений: врать «Вкл» тоже нельзя', () => {
    // Значения при `unknown` мягкие по уговору v4.32.655, но если сюда всё же
    // приедет `true`, подпись обязана остаться честной.
    expect(guardValue({ ...base, copyGuardUnknown: true, copyGuard: true })).toBe(
      'не удалось прочитать'
    );
    expect(guardValue({ ...base, copyGuardUnknown: true, copyGuardByPeer: true })).toBe(
      'не удалось прочитать'
    );
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: три прежние подписи не тронуты', () => {
    expect(guardValue({ ...base, copyGuard: true })).toBe('Вкл');
    expect(guardValue({ ...base, copyGuardByPeer: true })).toBe('Вкл собеседником');
    expect(guardValue(base)).toBe('Выкл');
  });

  it('ГРАНИЦА: подпись та же, что у соседей по карточке', () => {
    // Одно событие называется в приложении одним словом (v4.32.1053).
    expect(guardValue({ ...base, copyGuardUnknown: true })).toBe(
      hubSettings({ ...base, convUnknown: true }).find((i) => i.id === 'disappear')?.value
    );
  });
});

describe('форма правки в карточке', () => {
  it('карточка спрашивает ядро о полноте ответа', () => {
    expect(PEEK).toContain("import { copyGuardView } from '../../core/social/copyGuard';");
    expect(PEEK).toContain('copyGuardView(pub),');
    expect(PEEK).toContain('setCopyGuardUnknown(guard.unknown);');
    expect(PEEK).toContain('copyGuardUnknown,');
    // Сброс при закрытии карточки метит и новое поле: иначе чужое «не
    // прочиталось» осталось бы висеть на следующем человеке.
    expect(PEEK).toContain('setCopyGuardUnknown(false);');
  });

  it('нажатие на непрочитанном состоянии ничего не включает', () => {
    const at = PEEK.indexOf('const toggleCopyGuard = useCallback(');
    expect(at).toBeGreaterThan(0);
    const body = PEEK.slice(at, PEEK.indexOf('\n  }, [resolved,', at));
    expect(body).toContain('if (copyGuardUnknown) {');
    expect(body).toContain("'Не удалось прочитать запрет',");
    // Выход стоит ВЫШЕ разбора чужого решения: иначе `copyGuardByPeer`, ещё
    // ложный, увёл бы в ветку включения.
    expect(body.indexOf('if (copyGuardUnknown) {')).toBeLessThan(
      body.indexOf('if (!copyGuard && copyGuardByPeer) {')
    );
    // И выше самого включения — иначе конверт ушёл бы собеседнику.
    expect(body.indexOf('if (copyGuardUnknown) {')).toBeLessThan(
      body.indexOf('const next = !copyGuard;')
    );
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: разбор чужого решения и включение целы', () => {
    expect(PEEK).toContain("'Запрет включил собеседник',");
    expect(PEEK).toContain('void setCopyGuardAndSync({ peerPubB64: pub, on: next })');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('приложение на том же отказе переписку запирает', () => {
    // Вот с чем спорила подпись «Выкл»: ответ, которым закрывают переписку,
    // и ответ, которым её рисуют, читают одно и то же и расходятся.
    expect(GUARD).toContain('return state === null ? true : copyGuardOn(state);');
    expect(GUARD).toContain('return guardedNow(activeProfileId(), peerPubB64);');
  });

  it('мягкость ответа экрану сохранена буквально', () => {
    // v4.32.655 не перевёрнута: переключатель при незнании остаётся
    // выключенным, изменилась только подпись рядом с ним. Закрепка нарочно
    // не держит написание — оно и было переписано этой правкой.
    expect(GUARD).toContain('{ mine: false, theirs: false');
    expect(GUARD).toContain("log.warn('copy_guard_read_failed', { pid });");
  });

  it('строку включения нажимают из карточки, а не только из переписки', () => {
    expect(PEEK).toContain("case 'copy_guard': toggleCopyGuard(); return;");
    expect(hubSettings(base).some((i) => i.id === 'copy_guard')).toBe(true);
  });
});
