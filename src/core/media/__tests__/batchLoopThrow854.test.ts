/**
 * Дефект: в цикле пакетной отправки медиа не было `try`/`catch` на элемент.
 * Бросок на третьем ролике улетал во внешний `catch` всего обработчика —
 * человек видел «Не удалось отправить видео», хотя два ролика уже лежали в
 * переписке и уже ушли собеседнику (в группе — ещё и разосланы участникам).
 * Отчёт `batchSendReport` при этом не вызывался вовсе: ни одного числа.
 *
 * Цена: человек отправляет всё заново, и доставленное приходит второй раз.
 * У фотографий в группе цена другая и выше: там снимки грузятся в цикле, а
 * сообщение собирается после него — бросок на одном снимке отменял отправку
 * всех остальных, хотя они загрузились бы.
 *
 * Правка: тело каждого цикла, который грузит медиа поэлементно, обёрнуто в
 * `try`/`catch`; в `catch` растёт тот самый счётчик потерь, который потом
 * читает `batchSendReport`. Правило здесь — не список мест, а форма: любой
 * такой цикл обязан пережить бросок на одном элементе. В v4.32.842 счётчик
 * появился лишь в одном из пяти циклов, и проверка была привязана к его
 * имени — поэтому остальные четыре молчали ещё две недели.
 */
import fs from 'fs';
import path from 'path';
import { batchSendReport } from '../mediaSendReport';

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

/** Только код: комментарий, где написано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const CHAT = codeOnly(read('ui', 'screens', 'ChatScreen.tsx'));
const GROUPS = codeOnly(read('ui', 'screens', 'GroupsScreen.tsx'));

/** Текст от открывающей скобки `at` до парной ей закрывающей включительно. */
function block(src: string, at: number): string {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

type Loop = { body: string; end: number };

/**
 * Каждый цикл, который грузит медиа по одному. Не список имён: признак —
 * `uploadMediaToCid` внутри тела. Появится шестой такой цикл — он попадёт
 * сюда сам и обязан будет соблюдать то же правило.
 */
function mediaLoops(src: string): Loop[] {
  const out: Loop[] = [];
  const re = /^[ \t]*for \(const [A-Za-z0-9_]+ of [^\n]+\{$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const body = block(src, open);
    if (body.includes('uploadMediaToCid(')) out.push({ body, end: open + body.length });
  }
  return out;
}

/** Имя счётчика потерь, который читает отчёт сразу после цикла. */
function lostCounterAfter(src: string, loop: Loop): string {
  const at = src.indexOf('batchSendReport(', loop.end);
  expect(at).toBeGreaterThan(0);
  const call = src.slice(at, at + 400);
  // Поле пишут и полностью, и сокращённо (`failed,`) — счётчик тот же.
  const m = /failed:\s*([A-Za-z0-9_.]+)/.exec(call);
  if (m) return m[1];
  expect(call).toMatch(/[,{]\s*failed\s*[,}]/);
  return 'failed';
}

/** Блоки `catch` внутри тела цикла. */
function catchBlocks(body: string): string[] {
  const out: string[] = [];
  const re = /catch \([A-Za-z0-9_]+\) \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(block(body, m.index + m[0].length - 1));
  return out;
}

const ALL: Array<{ name: string; src: string }> = [
  { name: 'ChatScreen', src: CHAT },
  { name: 'GroupsScreen', src: GROUPS },
];

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('циклы поэлементной загрузки вообще находятся — и их пять', () => {
    expect(mediaLoops(CHAT)).toHaveLength(2);
    expect(mediaLoops(GROUPS)).toHaveLength(3);
  });

  it('у каждого найденного цикла есть отчёт со счётчиком потерь', () => {
    for (const { src } of ALL) {
      for (const loop of mediaLoops(src)) {
        expect(lostCounterAfter(src, loop)).toMatch(/^[A-Za-z0-9_.]+$/);
      }
    }
  });
});

describe('бросок на одном элементе не отменяет остальные', () => {
  it('тело каждого цикла обёрнуто в try до первой загрузки', () => {
    for (const { name, src } of ALL) {
      for (const loop of mediaLoops(src)) {
        const t = loop.body.indexOf('try {');
        const up = loop.body.indexOf('uploadMediaToCid(');
        expect(`${name}: try перед загрузкой = ${t > -1 && t < up}`).toBe(
          `${name}: try перед загрузкой = true`,
        );
      }
    }
  });

  it('в catch растёт тот самый счётчик, который потом читает отчёт', () => {
    for (const { name, src } of ALL) {
      for (const loop of mediaLoops(src)) {
        const counter = lostCounterAfter(src, loop);
        const grows = catchBlocks(loop.body).filter(
          (c) => c.includes(`${counter}++`) || c.includes(`${counter} += 1`),
        );
        expect(`${name}/${counter}: ${grows.length}`).toBe(`${name}/${counter}: 1`);
      }
    }
  });

  it('этот catch не глухой — потеря попадает в журнал', () => {
    for (const { src } of ALL) {
      for (const loop of mediaLoops(src)) {
        const counter = lostCounterAfter(src, loop);
        const grows = catchBlocks(loop.body).find(
          (c) => c.includes(`${counter}++`) || c.includes(`${counter} += 1`),
        );
        expect(grows).toContain('log.warn(');
        expect(grows).toContain('rawErrorText(e)');
      }
    }
  });
});

describe('что человек теперь видит вместо общего отказа', () => {
  it('сорвался один ролик из трёх — названы и ушедшие, и потерянные', () => {
    const text = batchSendReport({ total: 3, sent: 2, oversize: 0, failed: 1, refused: 0 }, 'video', null);
    expect(text).not.toBeNull();
    expect(text).toContain('2 из 3');
    expect(text).toContain('не загрузилось');
  });

  it('сорвался единственный снимок — отчёт не выдумывает превышения размера', () => {
    const text = batchSendReport({ total: 1, sent: 0, oversize: 0, failed: 1, refused: 0 }, 'photo', null);
    expect(text).not.toBeNull();
    expect(text).not.toContain('слишком');
    expect(text).not.toContain('Предел');
  });

  it('ушло всё — молчим, лишнего сообщения после правки не появилось', () => {
    expect(batchSendReport({ total: 3, sent: 3, oversize: 0, failed: 0, refused: 0 }, 'video', null)).toBeNull();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('внешний catch на месте, и сказать ему нечего: в его тексте нет ни одного числа', () => {
    const blanket = 'Не удалось отправить видео';
    for (const { src } of ALL) expect(src).toContain(`userErrorText(e, '${blanket}')`);
    expect(blanket).not.toMatch(/\d/);
  });

  it('к моменту броска часть уже доставлена — рассылка идёт внутри цикла', () => {
    const sends = mediaLoops(GROUPS).filter((l) => l.body.includes('announceGroupSend('));
    expect(sends).toHaveLength(2);
    // v4.32.893: запись переведена на бросающую обёртку — сама по себе она
    // здесь ничего не меняет (отказ ловит тот же `catch` и считает видео
    // несостоявшимся), но имя вызова служит меткой «строка пишется в цикле».
    for (const l of sends) expect(l.body).toContain('await insertGroupMessageOrThrow(row);');
  });

  it('у фотографий в группе цена другая: сообщение собирается после цикла', () => {
    const photo = mediaLoops(GROUPS).find((l) => l.body.includes('guessImageMime('));
    expect(photo).toBeDefined();
    expect((photo as Loop).body).not.toContain('insertGroupMessage(');
    // v4.32.873: проверка та же, выход тот же — перед ним лишь возвращается
    // подпись, которая иначе пропадала вместе с неудавшейся пачкой.
    expect(GROUPS).toContain('if (cids.length === 0) {');
    expect(GROUPS).toContain('if (caption.trim()) putGroupText(caption);');
  });
});
