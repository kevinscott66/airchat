/**
 * v4.32.872. «Копировать» уносило в буфер служебный конверт вместо текста.
 *
 * Дефект. Правило «что из сообщения можно положить в буфер» существовало в
 * одном месте из шести — в меню сообщения группы (`isTextMsg`). Пять
 * остальных мест брали `m.text` как есть: пачка выделенных в переписке, такая
 * же пачка в группе, быстрое меню в переписке (там условие было, но одно —
 * голый управляющий байт вложения), быстрое меню в группе (шире, но без
 * документа, геометки и контакта) и сам пункт меню группы, который у
 * пересылки копировал служебный байт конверта вместе с именем автора.
 *
 * Цена. Человек нажимает «Копировать», видит «Скопировано» и вставляет в
 * чужую переписку конверт голосового, путь к своему файлу на диске или свои
 * координаты. Ни увидеть заранее, ни заметить после он этого не может: буфер
 * показывает только то, что уже вставлено. Пачка выделенных — худший случай:
 * одна голосовая среди десяти реплик портила всю вставку, и сказать об этом
 * было некому.
 *
 * Правка. Правило одно и живёт в `core/social/copyBody.ts` рядом с
 * `exportBody`, который решает ту же задачу для выгрузки в файл. Отличие
 * намеренное: файл пишет пометку `[Голосовое сообщение]` — строка в документе
 * обязана остаться; буфер ничего не обязан, а пометка в скобках, вставленная
 * в чужой чат, читается как слова автора. Нечего копировать — так и сказано.
 * Пачка отчитывается числом: «Скопировано 3 из 7».
 */
import fs from 'fs';
import path from 'path';

import {
  COPY_NOTHING_TEXT,
  copySelection,
  copySelectionText,
  copyableBody,
} from '../../../core/social/copyBody';
import { FORWARD_PREFIX } from '../../../core/social/forwardEnvelope';
import { VIEW_ONCE_PREFIX } from '../../../core/social/messagePreview';
import { SYS_LINE_PREFIX } from '../../../core/social/sysLineGuard';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

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

const SITES: Record<string, string> = {
  'переписка': 'ui/screens/ChatScreen.tsx',
  'группа': 'ui/screens/GroupsScreen.tsx',
};

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('оба экрана на месте и по-прежнему кладут что-то в буфер', () => {
    for (const [name, rel] of Object.entries(SITES)) {
      const src = codeOnly(read(rel));
      expect([name, src.length > 10000]).toEqual([name, true]);
      // v4.32.883: писать в буфер стали через общий copyText — здесь важно
      // лишь то, что экран по-прежнему что-то копирует.
      expect([name, src.includes('copyText(')]).toEqual([name, true]);
    }
  });

  it('разбор конвертов, на который опирается правило, жив', () => {
    expect(copyableBody({ text: 'привет' })).toBe('привет');
  });
});

/** Служебные байты собираем из кодов — чтобы их не потеряли ни правка, ни редактор. */
const C = (n: number): string => String.fromCharCode(n);
const MEDIA = C(1);
const VOICE = `${MEDIA}voice:`;
const POLL = `${C(4)}poll:`;
const CONTACT = `${C(5)}contact:`;
const DOC = `${C(6)}doc:`;
const LOC = `${C(7)}loc:`;
const GIF = `${C(10)}gif:`;
const JOIN = `${C(10)}gjr:`;
const LIVELOC = `${C(12)}liveloc:`;
const READ_MARK = C(3);
const REACTION = C(16);

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('конверты приходят в то же поле, что и обычный текст', () => {
    // Тело сообщения — одно поле `text` на всё: и слова, и голосовое, и
    // документ. Отличить их можно только по первому байту, а значит
    // копирование без разбора не могло не выносить конверт наружу.
    expect(VIEW_ONCE_PREFIX.charCodeAt(0)).toBe(9);
    expect(SYS_LINE_PREFIX.charCodeAt(0)).toBe(11);
    expect(FORWARD_PREFIX.charCodeAt(0)).toBe(8);
    expect(`${VOICE}{}`.slice(1)).toBe('voice:{}');
  });

  it('в выгрузке та же задача решена давно — было откуда взять правило', () => {
    const exportSrc = codeOnly(read('core/social/exportLine.ts'));
    expect(exportSrc).toContain('export function exportBody(');
    expect(exportSrc).toContain('bodyKind(');
  });
});

describe('копируется только то, что человек видел глазами', () => {
  const MACHINE: ReadonlyArray<readonly [string, string]> = [
    ['голосовое', `${VOICE}{"cid":"Qm1","dur":7}`],
    ['опрос', `${POLL}{"q":"Когда?","opts":["Да","Нет"]}`],
    ['контакт', `${CONTACT}{"did":"did:key:z6Mk"}`],
    ['документ', `${DOC}{"path":"/var/mobile/Containers/Data/otchet.pdf"}`],
    ['геометка', `${LOC}{"lat":55.75,"lon":37.61}`],
    ['одноразовое', `${VIEW_ONCE_PREFIX}{"cid":"Qm2"}`],
    ['GIF', `${GIF}{"cid":"Qm3"}`],
    ['живая геометка', `${LIVELOC}{"lat":55.75,"lon":37.61,"until":0}`],
    ['вложение', `${MEDIA}Qm4`],
    ['системная строка', `${SYS_LINE_PREFIX}Алексей добавил Марию`],
    ['отметка о прочтении', `${READ_MARK}{"ids":["a"]}`],
    ['реакция', `${REACTION}{"id":"a","emoji":"OK"}`],
    ['заявка в группу', `${JOIN}{"gid":"g1"}`],
  ];

  it.each(MACHINE)('%s в буфер не кладётся', (_name, text) => {
    expect(copyableBody({ text })).toBeNull();
  });

  it('обычный текст проходит как есть', () => {
    expect(copyableBody({ text: 'Встретимся в семь' })).toBe('Встретимся в семь');
    expect(copyableBody({ text: 'две\nстроки' })).toBe('две\nстроки');
  });

  it('нечитаемая реплика не копируется — расшифровать её нечем', () => {
    expect(copyableBody({ text: 'мусор', unreadable: true })).toBeNull();
  });

  it('пустое и одни пробелы — тоже нечего копировать', () => {
    expect(copyableBody({ text: '' })).toBeNull();
    expect(copyableBody({ text: '   \n\t ' })).toBeNull();
    expect(copyableBody(null)).toBeNull();
    expect(copyableBody({})).toBeNull();
  });

  it('невидимые управляющие байты в буфер не уезжают', () => {
    // Та же чистка, что перед показом: в буфере ровно то, что на экране.
    expect(copyableBody({ text: `при${C(0)}вет` })).toBe('привет');
    expect(copyableBody({ text: `ле${C(0x202e)}во` })).toBe('лево');
  });
});

describe('пересылка: наружу идёт тело, а не конверт', () => {
  it('служебный байт и имя автора остаются внутри приложения', () => {
    expect(copyableBody({ text: `${FORWARD_PREFIX}Мария\nБуду в восемь` })).toBe('Буду в восемь');
  });

  it('пересылка пересылки разворачивается до текста', () => {
    const t = `${FORWARD_PREFIX}Пётр\n${FORWARD_PREFIX}Мария\nБуду в восемь`;
    expect(copyableBody({ text: t })).toBe('Буду в восемь');
  });

  it('переслали голосовое — копировать всё так же нечего', () => {
    expect(copyableBody({ text: `${FORWARD_PREFIX}Мария\n${VOICE}{"cid":"Qm1"}` })).toBeNull();
  });

  it('матрёшка конвертов не вешает разбор', () => {
    const deep = `${FORWARD_PREFIX}И\n`.repeat(40) + 'дно';
    expect(copyableBody({ text: deep })).toBeNull();
    const shallow = `${FORWARD_PREFIX}И\n`.repeat(3) + 'дно';
    expect(copyableBody({ text: shallow })).toBe('дно');
  });

  it('конверт без переноса разбирается как тело — и копируется телом', () => {
    // Так его читает и сам кодек (`parseForwardedMessage`), и пузырь на
    // экране: имени нет, всё после префикса — текст. Значит и в буфер идёт
    // ровно то, что человек видит.
    expect(copyableBody({ text: `${FORWARD_PREFIX}Буду в восемь` })).toBe('Буду в восемь');
  });

  it('пересылка с именем, но без тела — копировать нечего', () => {
    expect(copyableBody({ text: `${FORWARD_PREFIX}Мария\n` })).toBeNull();
    expect(copyableBody({ text: `${FORWARD_PREFIX}Мария\n   ` })).toBeNull();
  });
});

describe('пачка выделенных отчитывается честно', () => {
  const rows = [
    { text: 'раз' },
    { text: `${VOICE}{"cid":"Qm1"}` },
    { text: 'два' },
    { text: `${DOC}{"path":"/a.pdf"}` },
  ];

  it('в буфер идут только текстовые, через пустую строку', () => {
    expect(copySelection(rows)).toEqual({ text: 'раз\n\nдва', copied: 2, skipped: 2 });
  });

  it('всё скопировалось — обычное «Скопировано», без лишних слов', () => {
    expect(copySelectionText(copySelection([{ text: 'раз' }, { text: 'два' }]))).toBeNull();
  });

  it('часть пропущена — сказано числом', () => {
    expect(copySelectionText(copySelection(rows))).toBe(
      'Скопировано 2 из 4: остальные в буфер не кладутся',
    );
  });

  it('пропущена одна — согласование по числу пропущенных', () => {
    const one = copySelection([{ text: 'раз' }, { text: `${VOICE}{}` }]);
    expect(copySelectionText(one)).toBe('Скопировано 1 из 2: остальное в буфер не кладётся');
  });

  it('копировать нечего — отказ, а не пустая строка под «Скопировано»', () => {
    const none = copySelection([{ text: `${VOICE}{}` }, { text: `${POLL}{}` }]);
    expect(none).toEqual({ text: '', copied: 0, skipped: 2 });
    expect(copySelectionText(none)).toBe(COPY_NOTHING_TEXT);
    expect(COPY_NOTHING_TEXT).toContain('Копировать нечего');
  });

  it('пустое выделение отказом и остаётся', () => {
    expect(copySelectionText(copySelection([]))).toBe(COPY_NOTHING_TEXT);
  });
});

describe('все шесть мест спрашивают одно правило', () => {
  it('сырое тело в буфер не кладёт ни один экран', () => {
    for (const [name, rel] of Object.entries(SITES)) {
      const src = codeOnly(read(rel));
      for (const bad of [
        '.map((m) => m.text).join(',
        'copyText(item.text',
        'copyText(quickReact.text',
        'copyText(quickReactMsg.text',
        'Clipboard.setString(',
      ]) {
        expect([name, bad, src.includes(bad)]).toEqual([name, bad, false]);
      }
    }
  });

  it('оба экрана берут правило из общего места, а не переписывают его', () => {
    for (const [name, rel] of Object.entries(SITES)) {
      const src = codeOnly(read(rel));
      expect([name, src]).toEqual([
        name,
        expect.stringContaining("from '../../core/social/copyBody'"),
      ]);
      expect([name, src.includes('copySelection(')]).toEqual([name, true]);
      expect([name, src.includes('copyableBody(')]).toEqual([name, true]);
    }
  });

  it('отказ пачки не снимает выделение — человеку есть что поправить', () => {
    for (const [name, rel] of Object.entries(SITES)) {
      const src = codeOnly(read(rel));
      expect([name, src]).toEqual([
        name,
        expect.stringContaining('if (sel.copied === 0) { showError(note ?? COPY_NOTHING_TEXT); return; }'),
      ]);
    }
  });

  it('быстрое меню переписки больше не показывает «Копировать» у конверта', () => {
    const modal = codeOnly(read('ui/components/modals/chat/ChatQuickReactModal.tsx'));
    expect(modal).toContain('copyableBody(target) === null');
    expect(modal).toContain('isMachineText');
    const model = codeOnly(read('ui/components/modals/chat/messageMenuModel.ts'));
    expect(model).toContain('const canCopy = !f.isMedia && !f.isMachineText && !f.copyBlocked;');
    // Пересылка конверта — дело другое: он уезжает целиком и остаётся собой.
    expect(model).toContain("if (!f.isMedia && !f.copyBlocked) primary.push('forward');");
  });

  it('быстрое меню группы — то же самое, отдельным условием', () => {
    const modal = codeOnly(read('ui/components/modals/groups/GroupQuickReactModal.tsx'));
    expect(modal).toContain('canCopy: boolean;');
    expect(modal).toContain('{isTextLike && canCopy ? (');
    const screen = codeOnly(read('ui/screens/GroupsScreen.tsx'));
    expect(screen).toContain('canCopy={copyableBody(quickReact) !== null}');
  });
});
