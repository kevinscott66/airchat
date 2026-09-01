/**
 * v4.32.469 — рэтчет: одно действие называется одним словом.
 *
 * Дефект был не в коде, а в текстах, и проходил там, где заметнее всего:
 * в меню сообщения группы на iOS пункт назывался «Копировать», а на Android —
 * «Скопировать»; в меню личной переписки на iOS оба слова стояли рядом в одном
 * списке; кнопка под QR-кодом говорила «Скопировать ID», а то же действие в
 * карточке контакта — «Копировать ID», и подсказка «попросите друга нажать
 * „Скопировать ID“» вела к кнопке, подписанной другим словом.
 *
 * Тест держит выбранное слово и то, что подписи берутся из одного места:
 * пока литералы не разрешены, разъехаться им негде.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  COPIED_ID,
  COPIED_LINK,
  COPIED_POLL_RESULTS,
  COPIED_TEXT,
  COPY_ACTION,
  COPY_ID_ACTION,
  COPY_LINK_ACTION,
} from '../clipboardText';

const UI_DIR = path.join(__dirname, '..');

/** Все .ts/.tsx интерфейса, кроме самого словаря и тестов. */
function uiSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        if (name !== '__tests__') walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(name) || name === 'clipboardText.ts') continue;
      out.push({ file: path.relative(UI_DIR, full), text: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(UI_DIR);
  return out;
}

/** Строки файла без комментариев — в них и ищем литералы. */
function codeLines(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'));
}

describe('проверка не пустая', () => {
  const files = uiSources();

  it('интерфейс прочитан целиком', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.file.endsWith('ChatScreen.tsx'))).toBe(true);
    expect(files.some((f) => f.file.endsWith('GroupQrModal.tsx'))).toBe(true);
  });

  it('codeLines выбрасывает комментарии, но не код', () => {
    expect(codeLines('  // «Копировать» в строчном\n  const a = 1;')).toEqual(['  const a = 1;']);
    // Блочный комментарий снимается целиком — даже строки-продолжения без звёздочки.
    expect(codeLines('/* начало\n«Копировать») хвост */\nconst b = 2;').join('|')).toBe('|const b = 2;');
  });
});

describe('выбранное слово', () => {
  it('несовершенный вид — как в системных меню Android', () => {
    expect(COPY_ACTION).toBe('Копировать');
    expect(COPY_LINK_ACTION).toBe('Копировать ссылку');
    expect(COPY_ID_ACTION).toBe('Копировать ID');
  });

  it('пункт меню начинается с того же глагола, что и остальные', () => {
    for (const label of [COPY_LINK_ACTION, COPY_ID_ACTION]) {
      expect(label.startsWith(COPY_ACTION + ' ')).toBe(true);
    }
  });

  it('подтверждения — в прошедшем времени: действие уже произошло', () => {
    expect(COPIED_TEXT).toBe('Скопировано');
    expect(COPIED_LINK).toBe('Ссылка скопирована');
    expect(COPIED_ID).toBe('ID скопирован');
    expect(COPIED_POLL_RESULTS).toBe('Результаты скопированы');
    for (const t of [COPIED_TEXT, COPIED_LINK, COPIED_ID, COPIED_POLL_RESULTS]) {
      expect(t.toLowerCase()).toContain('скопирова');
      expect(t).not.toContain('Копировать');
    }
  });

  it('у каждого подтверждения свой текст', () => {
    const all = [COPIED_TEXT, COPIED_LINK, COPIED_ID, COPIED_POLL_RESULTS];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('литералов в интерфейсе не осталось', () => {
  const files = uiSources();
  /** Написанный руками текст про копирование — то, что должно приходить из словаря. */
  const FORBIDDEN = [
    /['"«>]Копировать/,
    /['"«>]Скопировать/,
    /['"«>](?:ID|Идентификатор|Ссылка|Результаты) скопирован/i,
    /['"«>]Скопировано/,
  ];

  it.each(FORBIDDEN.map((re) => [re.source, re] as const))('нигде не пишут %s руками', (_src, re) => {
    const hits = files
      .filter((f) => codeLines(f.text).some((l) => re.test(l)))
      .map((f) => f.file);
    expect(hits).toEqual([]);
  });

  it('«Идентификатор скопирован» и «ID скопирован» — больше не два текста об одном', () => {
    const joined = files.map((f) => f.text).join('\n');
    expect(joined).not.toContain('Идентификатор скопирован');
  });

  it('словарь и правда используется, а не просто существует', () => {
    const users = files.filter((f) => f.text.includes("from '") && /clipboardText'/.test(f.text));
    expect(users.length).toBeGreaterThanOrEqual(10);
  });
});
