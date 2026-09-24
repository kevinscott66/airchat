/**
 * Экран «Произошла ошибка» говорит по-русски (v4.32.833).
 *
 * Дефект. Граница ошибок выводила на весь экран `error.message`, а русский
 * совет стоял в ветке `||` — то есть срабатывал только на ПУСТОМ сообщении.
 * Пустых сообщений у React-исключений практически не бывает.
 *
 * Цена. Это последнее, что человек видит от приложения: дерево уже сломалось,
 * других экранов нет. Вместо единственного, что тут можно сделать
 * («перезапустите, потом обновите»), он читал `undefined is not an object
 * (evaluating 'e.cid')`. Ровно тот же дефект разобрали в v4.32.428 на 54
 * местах сразу, и храповик `errorTextCallSites` с тех пор держит рукописную
 * развёртку `e instanceof Error ? e.message`. Здесь сообщение приезжает из
 * `getDerivedStateFromError` уже строкой — и мимо храповика проскочило.
 *
 * Правка. Правило берётся из того же дома (`isUserFacingMessage`): наш текст
 * для человека написан кириллицей, чужой — нет. Техническая подробность не
 * теряется, её пишет `componentDidCatch` и в журнал, и в ErrorHandler.
 *
 * Решение проверяется по-настоящему — на настоящих текстах React-исключений.
 * То, что граница спрашивает именно это решение, проверяется по исходнику:
 * отрисовать её нечем, react-test-renderer в проекте нет.
 */
import fs from 'fs';
import path from 'path';

import { isUserFacingMessage } from '../components/userErrorText';

const BOUNDARY = (): string =>
  fs
    .readFileSync(path.join(__dirname, '..', 'AppErrorBoundary.tsx'), 'utf8')
    // Только код: разбор дефекта в докблоке цитирует обе формы дословно и не
    // должен ни подтверждать проверку, ни нарушать запрет.
    .split('\n')
    .filter((l) => {
      const x = l.trim();
      return !(x.startsWith('//') || x.startsWith('*') || x.startsWith('/*'));
    })
    .join('\n');

/** Что реально бросают React Native и наши собственные модули. */
const REAL_CRASHES = [
  "undefined is not an object (evaluating 'e.cid')",
  'Maximum update depth exceeded',
  'Network request failed',
  'documentDirectory unavailable',
  'Text strings must be rendered within a <Text> component.',
  'send_at_out_of_range',
  'feed_storage_profile_unset',
  '"point" expected Uint8Array of length 32, got length=10',
  'SQLITE_BUSY: database is locked',
];

describe('решение: чужой текст на экран не попадает', () => {
  it('ни одно настоящее падение не проходит за текст для человека', () => {
    const leaked = REAL_CRASHES.filter((m) => isUserFacingMessage(m));
    expect(leaked).toEqual([]);
  });

  it('пустое сообщение тоже не проходит — прежняя ветка || ловила только его', () => {
    expect(isUserFacingMessage('')).toBe(false);
    expect(isUserFacingMessage('   ')).toBe(false);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: наш собственный текст проходит и будет показан', () => {
    expect(isUserFacingMessage('Не удалось прочитать хранилище')).toBe(true);
    expect(isUserFacingMessage('Пароль уже установлен')).toBe(true);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: дамп с кириллицей внутри за фразу не сходит', () => {
    expect(isUserFacingMessage(`{"ошибка":"${'x'.repeat(200)}"}`)).toBe(false);
    expect(isUserFacingMessage('Не удалось\nсохранить')).toBe(false);
  });
});

describe('граница ошибок спрашивает именно это решение', () => {
  it('совет — отдельная строка, а не ветка ||', () => {
    const s = BOUNDARY();
    expect(s).toContain(
      "const ADVICE = 'Перезапустите приложение. Если проблема повторится, обновите AirChat.';",
    );
    expect(s).toContain('{isUserFacingMessage(this.state.message) ? this.state.message : ADVICE}');
    expect(s).not.toContain("this.state.message || '");
  });

  it('правило берётся из общего дома, а не переписано здесь', () => {
    const s = BOUNDARY();
    expect(s).toContain("import { isUserFacingMessage } from './components/userErrorText';");
    expect(s).not.toContain('CYRILLIC');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: техническая подробность по-прежнему уходит в журнал', () => {
    const s = BOUNDARY();
    const at = s.indexOf('componentDidCatch(');
    expect(at).toBeGreaterThan(0);
    const body = s.slice(at, s.indexOf('\n  private clear', at));
    expect(body).toContain("log.error('react_error_boundary', {");
    expect(body).toContain('stack: error.stack,');
    expect(body).toContain('componentStack: errorInfo.componentStack,');
    expect(body).toContain("code: 'REACT_ERROR',");
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: храповик 428-й эту форму не ловил', () => {
    const HAND_ROLLED = /(\w+) instanceof Error \? \1\.message/;
    const s = BOUNDARY();
    expect(HAND_ROLLED.test(s)).toBe(false);
    // Сообщение приходит уже строкой — вот почему запрет здесь не срабатывал.
    expect(s).toContain('static getDerivedStateFromError(error: Error): Partial<State> {');
    expect(s).toContain('return { hasError: true, message: error.message };');
  });
});
