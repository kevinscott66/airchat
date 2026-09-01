import * as fs from 'fs';
import * as path from 'path';

/**
 * Храповик v4.32.428: сырой текст исключения не уходит на русский экран.
 *
 * До этой версии в src/ui было 88 рукописных копий одной записи
 * `e instanceof Error ? e.message : String(e)`. 54 из них отдавали результат
 * человеку, и человек читал `send_at_out_of_range`, `documentDirectory
 * unavailable`, `Network request failed`. Семь мест даже написали русский
 * запасной текст — но поставили его в ветку «брошено не-Error», которая почти
 * никогда не срабатывает.
 *
 * Теперь запись одна и живёт в userErrorText.ts: `userErrorText(e, запас)` для
 * экрана, `rawErrorText(e)` для журнала. Тест следит, чтобы рукописная форма
 * не вернулась и чтобы запасной текст был написан по-русски.
 */

const UI = path.join(__dirname, '..');
const HOME = 'components/userErrorText.ts';

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...collect(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Комментарии — не код: в них форма встречается как цитата и это нормально. */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*'));
    });
}

function relKey(full: string): string {
  return path.relative(UI, full).split(path.sep).join('/');
}

const FILES = collect(UI).map((full) => ({ key: relKey(full), source: fs.readFileSync(full, 'utf8') }));

/** Рукописная развёртка ошибки. Именно её и заменяет userErrorText.ts. */
const HAND_ROLLED = /(\w+) instanceof Error \? \1\.message/;

/** Кириллица — признак текста, написанного для человека. */
const CYRILLIC = /[А-Яа-яЁё]/;

describe('храповик: текст ошибки для человека', () => {
  it('в src/ui нет рукописного `x instanceof Error ? x.message`, кроме самого userErrorText.ts', () => {
    const offenders: string[] = [];
    for (const { key, source } of FILES) {
      if (key === HOME) continue;
      codeLines(source).forEach((line) => {
        if (HAND_ROLLED.test(line)) offenders.push(`${key}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('запрет не холостой: историческая строка формой ловится', () => {
    // Ровно так было написано в ChatScreen.tsx:2187 до v4.32.428.
    expect(HAND_ROLLED.test("        showError(e instanceof Error ? e.message : String(e));")).toBe(true);
    expect(HAND_ROLLED.test("      Alert.alert('AirChat', e instanceof Error ? e.message : String(e));")).toBe(true);
    // И вариант с другим именем переменной — их в коде было три.
    expect(HAND_ROLLED.test("        showError(err instanceof Error ? err.message : String(err));")).toBe(true);
    expect(HAND_ROLLED.test("        showError(error instanceof Error ? error.message : 'Ошибка создания');")).toBe(true);
  });

  it('запрет не холостой: законные записи формой НЕ ловятся', () => {
    expect(HAND_ROLLED.test("        showError(userErrorText(e, 'Не удалось отправить'));")).toBe(false);
    expect(HAND_ROLLED.test("        log.warn('send_failed', { err: rawErrorText(e) });")).toBe(false);
    // Проверка класса без чтения .message — законна и встречается в коде.
    expect(HAND_ROLLED.test("        if (e instanceof Error) return;")).toBe(false);
    // Разные переменные в двух половинах — это не та форма (обратная ссылка).
    expect(HAND_ROLLED.test("        const t = a instanceof Error ? b.message : '';")).toBe(false);
  });

  it('каждый вызов userErrorText получает запасной текст по-русски', () => {
    // Английский запасной текст вернул бы дефект другим путём: человек снова
    // читает не свой язык, только теперь это уже наша собственная строка.
    const bad: string[] = [];
    for (const { key, source } of FILES) {
      if (key === HOME) continue;
      codeLines(source).forEach((line) => {
        const call = line.match(/userErrorText\(\s*\w+\s*,\s*(.+?)\)\s*[),;]/);
        if (!call) return;
        const fallback = call[1];
        // `t('...')` — путь через словарь переводов, он русский по построению.
        if (fallback.startsWith('t(')) return;
        // v4.32.531: запасной текст может приехать параметром — так устроены
        // общие перехватчики отказов (`runGuardedOp`, `runRowOp`) и словарь
        // переключателей группы. Русская строка тогда стоит на вызове
        // перехватчика, а не здесь; за неё отвечает отдельный храповик
        // (grpFlagToggle.test.ts). Пропускаем только эти две формы: любое
        // другое выражение вместо строки по-прежнему нарушение.
        if (/^(fallback|[A-Za-z_$][\w$]*\.failure)$/.test(fallback)) return;
        if (!CYRILLIC.test(fallback)) bad.push(`${key}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('вызовы userErrorText действительно есть — тест выше не холостой', () => {
    const users = FILES.filter(({ key, source }) => key !== HOME && /\buserErrorText\(/.test(source));
    expect(users.length).toBeGreaterThanOrEqual(15);
  });

  it('вызовы rawErrorText действительно есть — журнал не потерян', () => {
    const users = FILES.filter(({ key, source }) => key !== HOME && /\brawErrorText\(/.test(source));
    expect(users.length).toBeGreaterThanOrEqual(8);
  });

  it('планирование отправки не проваливается молча', () => {
    // scheduleMessage/scheduleGroupMessage бросают на выбранном времени
    // (`send_at_out_of_range`) и на длине текста. До v4.32.428 оба вызова шли
    // без catch внутри `void (...)`: отказ становился необработанным
    // отклонением промиса, окно закрывалось, и человек не видел НИЧЕГО —
    // ни ошибки, ни подтверждения. Молчание хуже английского текста.
    const CALLS = ['await scheduleMessage(', 'await scheduleGroupMessage('];
    const unguarded: string[] = [];
    let seen = 0;
    for (const { key, source } of FILES) {
      const lines = source.split('\n');
      lines.forEach((line, i) => {
        if (!CALLS.some((c) => line.includes(c))) return;
        seen += 1;
        const window = lines.slice(i, i + 5).join('\n');
        if (!/catch \(/.test(window) || !/userErrorText\(/.test(window)) {
          unguarded.push(`${key}:${i + 1}`);
        }
      });
    }
    expect(unguarded).toEqual([]);
    expect(seen).toBe(2);
  });

  it('дом правила один — userErrorText объявлен ровно в одном файле', () => {
    const homes = FILES.filter(({ source }) => /export function userErrorText\(/.test(source));
    expect(homes.map((f) => f.key)).toEqual([HOME]);
  });
});
