/**
 * Выгрузка переписки больше не выносит служебные тела в файл (v4.32.806).
 *
 * Дефект. `exportBody` вырезала управляющие символы и считала это защитой.
 * Вырезался ровно один байт — тот, что обозначает тип конверта, — а тело
 * конверта оставалось. Строка `\x04poll:{"q":…}` уходила в файл как
 * `poll:{"q":…}`, `\x05contact:{…}` — вместе с номером телефона и открытым
 * ключом, `\x06doc:{…}` — с локальным путём к файлу на устройстве,
 * `\x07loc:` и `\x0cliveloc:` — с координатами, `\x0bsys:` — с остатком
 * `sys:`, а `\x08fwd:Имя` — с чужим именем в теле реплики. Подпись
 * одноразового сообщения не трогалась вообще: её байт — табуляция (\x09), и
 * в список вырезаемых он не входит и входить не может.
 *
 * Цена. Выгрузка — это файл, который сохраняют, кладут в облако и пересылают.
 * Он оказался единственным местом, где подпись одноразового оседает
 * постоянным текстом: поиск вырезает её из индекса, подпись в списке
 * подменяет, пересылка наружу не выносит — а выгрузка выносила. Остальное
 * ничем не лучше: координаты и телефон из карточки контакта попадают в файл
 * в виде, пригодном для чтения машиной, и человек, нажавший «Экспорт»,
 * никакого способа это заметить не имеет.
 *
 * Правка. Список «какой префикс — какой тип» вынесен в `bodyKind` и стал
 * общим с подписью: второй копии, которая разойдётся с первой, больше нет.
 * Файл пишет слово в скобках — `[Опрос]`, `[Контакт]` — без значка: значок
 * хорош в одной строке списка, а файл читают глазами. Пересылка
 * разворачивается в «↪ Имя: тело», имя чистится тем же правилом, что и в
 * пузыре, а чужой текст проходит через общую чистку — U+202E в файле
 * переворачивает строку вместе со временем и именем.
 */
import fs from 'fs';
import path from 'path';

import {
  EXPORT_CONTROL_TEXT,
  EXPORT_FORWARD_TEXT,
  EXPORT_MEDIA_TEXT,
  EXPORT_UNREADABLE_TEXT,
  exportBody,
} from '../exportLine';
import { bodyKind, previewLabelForText } from '../messagePreview';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const EXPORT = codeOnly(read('core', 'social', 'exportLine.ts'));
const PREVIEW = codeOnly(read('core', 'social', 'messagePreview.ts'));

/** Конверты с настоящими телами — ровно то, что уезжало в файл. */
const ENVELOPES: Array<[string, string, string]> = [
  ['голосовое', '\x01voice:{"uri":"file:///data/user/0/com.anonymous.airchat/cache/a.m4a"}', '[Голосовое сообщение]'],
  ['опрос', '\x04poll:{"q":"Куда едем?","opts":["Домой","В горы"]}', '[Опрос]'],
  ['контакт', '\x05contact:{"name":"Аня","phone":"+79990000000","pub":"BASE64KEY"}', '[Контакт]'],
  ['документ', '\x06doc:{"name":"паспорт.pdf","uri":"file:///var/mobile/x.pdf"}', '[Документ]'],
  ['геолокация', '\x07loc:{"lat":55.75,"lon":37.61}', '[Геолокация]'],
  ['одноразовое', '\x09vo:подпись к снимку', '[Одноразовое сообщение]'],
  ['GIF', '\x0agif:https://media.giphy.com/media/x/giphy.gif', '[GIF]'],
  ['живая геолокация', '\x0cliveloc:{"lat":55.75,"lon":37.61,"until":1}', '[Живая геолокация]'],
];

describe('служебное тело не доезжает до файла', () => {
  it.each(ENVELOPES)('%s обозначено пометкой', (_name, text, expected) => {
    expect(exportBody({ text })).toBe(expected);
  });

  it.each(ENVELOPES)('%s не оставляет в файле ни байта своего тела', (_name, text) => {
    const out = exportBody({ text });
    const payload = text.slice(text.indexOf(':') + 1);
    expect(out).not.toContain(payload);
    // И сам префикс без управляющего байта — тоже след конверта.
    expect(out).not.toMatch(/(voice|poll|contact|doc|loc|liveloc|gif|vo):/);
  });

  it('подпись одноразового не попадает в файл — её байт вообще не вырезался', () => {
    // \x09 — табуляция: в списке вырезаемых управляющих символов её нет и
    // быть не может, файл выгрузки разделяет ею столбцы.
    expect(exportBody({ text: '\x09vo:встретимся у метро в 19' })).toBe('[Одноразовое сообщение]');
    expect(exportBody({ text: '\x09vo:встретимся у метро в 19' })).not.toContain('метро');
  });

  it('системная строка идёт человеческим текстом, а не остатком префикса', () => {
    expect(exportBody({ text: '\x0bsys:Исчезающие сообщения включены' }))
      .toBe('Исчезающие сообщения включены');
    expect(exportBody({ text: '\x0bsys:Группа переименована' })).not.toContain('sys:');
  });

  it('пересылка разворачивается в имя и тело', () => {
    expect(exportBody({ text: '\x08fwd:Аня\nпривет' })).toBe('↪ Аня: привет');
    expect(exportBody({ text: '\x08fwd:Аня\n\x04poll:{"q":"?"}' })).toBe('↪ Аня: [Опрос]');
    expect(exportBody({ text: '\x08fwd:привет' })).toBe('↪ привет');
    expect(exportBody({ text: '\x08fwd:Аня\n' })).toBe(`↪ Аня: ${EXPORT_FORWARD_TEXT}`);
  });

  it('имя в пересылке чистится — иначе оно допишет в файл лишнюю строку', () => {
    // Строка файла выглядит как «[время] Имя: текст»; перевод строки в чужом
    // имени подделал бы ещё одну реплику, которой не было.
    // Разрез идёт по первому '\n', поэтому подделка едет тем, что переводом
    // строки не считается при разборе, но считается в файле: '\r' и U+2028.
    const out = exportBody({ text: '\x08fwd:Аня\r[12:00] Боря\u2028Вера\nпривет' });
    expect(out).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(out.startsWith('↪ Аня')).toBe(true);
    expect(out.endsWith(': привет')).toBe(true);
  });

  it('вложенная пересылка не уводит разбор в бесконечность', () => {
    const deep = '\x08fwd:А\n'.repeat(500) + 'привет';
    const out = exportBody({ text: deep });
    expect(out).toContain(EXPORT_FORWARD_TEXT);
    expect(out).not.toContain('fwd:');
  });

  it('служебный конверт без человеческого вида обозначен как служебный', () => {
    for (const c of ['\x02grp:{"k":"…"}', '\x0freact:{}', '\x11dis:{}', '\x13story:{}']) {
      expect(exportBody({ text: c })).toBe(EXPORT_CONTROL_TEXT);
    }
  });

  it('метка переворота строки не доезжает до файла', () => {
    // В файле U+202E разворачивает строку вместе со временем и именем.
    expect(exportBody({ text: '‮привет' })).toBe('привет');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежний договор выгрузки цел', () => {
  it('непрочитанная реплика по-прежнему сильнее всего остального', () => {
    expect(exportBody({ text: '\x04poll:{}', unreadable: true })).toBe(EXPORT_UNREADABLE_TEXT);
    expect(exportBody({ text: '\x09vo:подпись', unreadable: true })).toBe(EXPORT_UNREADABLE_TEXT);
  });

  it('обычное вложение — всё та же пометка', () => {
    expect(exportBody({ text: '\x01{"cid":"a"}' })).toBe(EXPORT_MEDIA_TEXT);
    expect(exportBody({ text: '\x01' })).toBe(EXPORT_MEDIA_TEXT);
  });

  it('обычный текст проходит насквозь, вместе с переносами', () => {
    expect(exportBody({ text: 'привет' })).toBe('привет');
    expect(exportBody({ text: 'а\nб\tв\r' })).toBe('а\nб\tв\r');
    expect(exportBody({ text: '' })).toBe('');
    expect(exportBody(null)).toBe('');
  });

  it('пометки оформлены скобками, как принято в файле', () => {
    for (const t of [EXPORT_CONTROL_TEXT, EXPORT_FORWARD_TEXT, EXPORT_MEDIA_TEXT, EXPORT_UNREADABLE_TEXT]) {
      expect(t.startsWith('[')).toBe(true);
      expect(t.endsWith(']')).toBe(true);
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('подпись сообщения знает все эти типы — и знала их всё время', () => {
    expect(previewLabelForText('\x04poll:{"q":"?"}')).toBe('📊 Опрос');
    expect(previewLabelForText('\x09vo:подпись')).toBe('🔥 Одноразовое сообщение');
    expect(previewLabelForText('\x0cliveloc:{}')).toBe('📡 Живая геолокация');
  });

  it('подпись одноразового прячут везде, кроме выгрузки — это и была дыра', () => {
    // Слова про поиск не наши: searchableText вырезает подпись из индекса
    // целиком, и объяснение стоит прямо в нём.
    const search = codeOnly(read('core', 'social', 'searchableText.ts'));
    expect(search).toContain("const VIEW_ONCE = '\\x09vo:';");
    expect(search).toContain('if (text.startsWith(VIEW_ONCE)) return \'\';');
  });
});

describe('форма исходников: список типов один на всех', () => {
  it('таблица типов живёт в одном месте и отдаёт значок отдельно от слова', () => {
    expect(PREVIEW).toContain('export function bodyKind(text: string | null | undefined): BodyKind | null {');
    expect(PREVIEW).toContain('const BODY_KINDS: ReadonlyArray<readonly [string, BodyKind]> = [');
    expect(PREVIEW).toContain('readonly icon: string;');
    expect(PREVIEW).toContain('readonly label: string;');
  });

  it('подпись собирается из той же таблицы, а не из своей цепочки', () => {
    expect(PREVIEW).toContain('const kind = bodyKind(text);');
    expect(PREVIEW).toContain('if (kind) return `${kind.icon} ${kind.label}`;');
    // Прежние восемь строк с готовыми подписями ушли целиком.
    expect(PREVIEW).not.toContain("return '📊 Опрос';");
    expect(PREVIEW).not.toContain("return '🔥 Одноразовое сообщение';");
  });

  it('выгрузка берёт слово из той же таблицы и без значка', () => {
    expect(EXPORT).toContain('const kind = bodyKind(text);');
    expect(EXPORT).toContain('if (kind) return `[${kind.label}]`;');
    // Значок в файле не нужен, и своего списка слов у выгрузки нет.
    expect(EXPORT).not.toContain('kind.icon');
    expect(EXPORT).not.toContain("'[Опрос]'");
  });

  it('таблица отдаёт значок и слово по отдельности — иначе одно из двух пришлось бы резать', () => {
    const poll = bodyKind('\x04poll:{}');
    expect(poll).toEqual({ icon: '📊', label: 'Опрос' });
    expect(bodyKind('привет')).toBeNull();
    expect(bodyKind('')).toBeNull();
    expect(bodyKind(null)).toBeNull();
    expect(bodyKind('текст с \x04poll: внутри')).toBeNull();
  });

  it('чужой текст выгрузка чистит общим правилом, а не своей заплаткой', () => {
    expect(EXPORT).toContain('return sanitizeBodyForRender(text);');
    expect(EXPORT).not.toContain('\\x0e-\\x1f');
  });
});
