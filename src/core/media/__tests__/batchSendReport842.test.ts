/**
 * Пачка больше не теряет вложения молча (v4.32.842).
 *
 * Дефект. Пять циклов отправки — видео из галереи и из листа вложений, в
 * личной переписке и в группе, плюс фотографии в группу — считали одну причину
 * отказа из трёх и докладывали цепочкой `else if`:
 *
 *   if (refusedCount > 0) …
 *   else if (skippedTooLarge > 0) …
 *   else if (!sentAny) 'Не удалось загрузить видео'
 *
 * Выбрали три ролика, один ушёл, два не загрузились не по размеру — и все три
 * условия ложны. Человеку не сказали ничего: в переписке появилось одно видео
 * вместо трёх, а почему — нигде. Там же, где причины считались, `else if`
 * называл только первую: отказ отправки прятал превышение размера.
 *
 * У фотографий было хуже: любая потеря объявлялась превышением размера, и к
 * ней приписывался предел — MAX_BLOB_BYTES по умолчанию, даже когда ни одного
 * превышения не было. То есть человеку называли неправду, с которой он ничего
 * не сделает: «уменьшите файл», когда файл был ни при чём.
 *
 * Цена. Ровно та же, за которую правили личные сообщения в v4.32.569: человек
 * уверен, что отправил, собеседник не получил, повторить нечего — выбор уже
 * закрылся. Потери были и до пачки, но там их хотя бы не скрывали.
 *
 * Правка. Один отчёт на все пять мест: считаются все причины, называются все
 * случившиеся, предел называется только при превышении.
 */

import { batchSendReport } from '../mediaSendReport';
import type { BatchTally } from '../mediaSendReport';
import { formatLimit } from '../uploadRoute';

import fs from 'fs';
import path from 'path';

const LIMIT = 8_000_000;

const tally = (t: Partial<BatchTally>): BatchTally => ({
  total: 0,
  sent: 0,
  oversize: 0,
  failed: 0,
  refused: 0,
  ...t,
});

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

describe('о каждой потере говорят', () => {
  it('ушло одно из трёх, два не загрузились — молчания больше нет', () => {
    const text = batchSendReport(tally({ total: 3, sent: 1, failed: 2 }), 'video', LIMIT);
    // ПРОВЕРКА НЕ ПУСТАЯ: сказано и сколько ушло, и сколько выбрали.
    expect(text).not.toBeNull();
    expect(text).toContain('1 из 3');
    expect(text).toContain('не загрузились');
  });

  it('ушло всё — говорить нечего', () => {
    expect(batchSendReport(tally({ total: 3, sent: 3 }), 'video', LIMIT)).toBeNull();
    expect(batchSendReport(tally({ total: 0, sent: 0 }), 'photo', LIMIT)).toBeNull();
  });

  it('причин несколько — названы все, а не первая', () => {
    const text = batchSendReport(
      tally({ total: 4, sent: 1, oversize: 1, failed: 1, refused: 1 }),
      'video',
      LIMIT,
    );
    expect(text).toContain('слишком большие');
    expect(text).toContain('не загрузились');
    expect(text).toContain('не отправились');
  });

  it('предел называют только там, где его вправду превысили', () => {
    const size = batchSendReport(tally({ total: 2, sent: 0, oversize: 2 }), 'photo', LIMIT);
    expect(size).toContain(formatLimit(LIMIT));

    const other = batchSendReport(tally({ total: 2, sent: 0, failed: 2 }), 'photo', LIMIT);
    expect(other).not.toContain(formatLimit(LIMIT));
    expect(other).not.toContain('Предел');
    // И наоборот: превышение было, а предел неизвестен — про него молчат, но
    // про саму причину говорят.
    const unknown = batchSendReport(tally({ total: 2, sent: 0, oversize: 2 }), 'photo', null);
    expect(unknown).toContain('слишком большие');
    expect(unknown).not.toContain('Предел');
  });

  it('потеряно одно — говорят в единственном числе', () => {
    const one = batchSendReport(tally({ total: 3, sent: 2, failed: 1 }), 'video', LIMIT);
    expect(one).toContain('остальное не загрузилось');
    const many = batchSendReport(tally({ total: 3, sent: 1, failed: 2 }), 'video', LIMIT);
    expect(many).toContain('остальные не загрузились');
  });

  it('не ушло ничего — про это говорят отдельно и называют предмет', () => {
    expect(batchSendReport(tally({ total: 1, sent: 0, oversize: 1 }), 'video', LIMIT)).toBe(
      `Видео не отправлено: слишком большое. Предел — ${formatLimit(LIMIT)}.`,
    );
    expect(batchSendReport(tally({ total: 2, sent: 0, failed: 2 }), 'photo', LIMIT)).toBe(
      'Фото не отправлены: не загрузились.',
    );
  });

  it('счёт не сошёлся — всё равно не молчат', () => {
    // Причина потерялась по дороге: выдумывать её не за что, но и промолчать
    // нельзя — молчание и есть дефект.
    const text = batchSendReport(tally({ total: 3, sent: 1 }), 'video', LIMIT);
    expect(text).not.toBeNull();
    expect(text).toContain('1 из 3');
    expect(text).not.toContain('слишком');
    expect(text).not.toContain('не загрузились');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  /** Прежняя цепочка, слово в слово, — чтобы её молчание было видно. */
  const oldChain = (o: {
    refusedCount: number;
    skippedTooLarge: number;
    sentAny: boolean;
  }): string | null => {
    if (o.refusedCount > 0) return `Отправить не удалось (видео: ${o.refusedCount})`;
    else if (o.skippedTooLarge > 0) return `Видео больше N отправить нельзя`;
    else if (!o.sentAny) return 'Не удалось загрузить видео';
    return null;
  };

  it('старая цепочка на этом самом случае молчала', () => {
    // Три ролика, один ушёл, два не загрузились не по размеру.
    expect(oldChain({ refusedCount: 0, skippedTooLarge: 0, sentAny: true })).toBeNull();
    // А новая — нет.
    expect(batchSendReport(tally({ total: 3, sent: 1, failed: 2 }), 'video', LIMIT)).not.toBeNull();
  });

  it('старая цепочка прятала вторую причину за первой', () => {
    const said = oldChain({ refusedCount: 1, skippedTooLarge: 2, sentAny: true });
    expect(said).toContain('Отправить не удалось');
    expect(said).not.toContain('больше');
  });

  it('«не загрузилось не по размеру» — не выдумка: такой отказ возвращают', () => {
    const upload = codeOnly(read('core', 'media', 'mediaUpload.ts'));
    expect(upload).toContain("reason: 'failed'");
    expect(upload).toContain("reason: 'oversize'");
    // Обе причины приходят из одного места, значит различить их было чем.
    expect(upload).toContain("| { ok: false; reason: 'oversize' | 'failed'; limitBytes: number }");
  });

  it('у фотографий предел приписывался к чужой причине', () => {
    // Прежний код: limitBytes заводился как MAX_BLOB_BYTES и назывался всегда,
    // когда cids.length < uris.length, — какой бы ни была причина.
    const oldPhotoText = (sent: number, total: number, limitBytes: number): string =>
      `Загружено ${sent} из ${total} фото — остальные слишком большие (предел ${formatLimit(limitBytes)})`;
    expect(oldPhotoText(1, 3, LIMIT)).toContain('слишком большие');
    // Ни одного превышения — а сказано про размер. Новый отчёт так не умеет.
    const now = batchSendReport(tally({ total: 3, sent: 1, failed: 2 }), 'photo', null);
    expect(now).not.toContain('слишком большие');
  });
});

describe('форма исходников', () => {
  it('все пять мест зовут общий отчёт', () => {
    expect(CHAT.match(/batchSendReport\(/g)).toHaveLength(2); // видео: галерея и лист вложений
    expect(GROUPS.match(/batchSendReport\(/g)).toHaveLength(3); // те же два плюс фотографии
    expect(CHAT).toContain("import { batchSendReport } from '../../core/media/mediaSendReport';");
    expect(GROUPS).toContain("import { batchSendReport } from '../../core/media/mediaSendReport';");
  });

  it('цепочки «else if» и флага sentAny не осталось', () => {
    for (const src of [CHAT, GROUPS]) {
      expect(src).not.toContain('sentAny');
      expect(src).not.toContain('Не удалось загрузить видео');
      expect(src).not.toContain('отправить нельзя (пропущено');
    }
    expect(GROUPS).not.toContain('остальные слишком большие (предел');
    expect(GROUPS).not.toContain("showError('Не удалось загрузить фото')");
  });

  it('каждая неудача попадает в счётчик — в том числе сорвавшаяся с исключением', () => {
    const at = CHAT.indexOf("log.warn('attachsheet_video_send_failed'");
    expect(at).toBeGreaterThan(0);
    // Счётчик стоит до записи в журнал, в том же блоке catch.
    expect(CHAT.slice(at - 200, at)).toContain('failedCount++;');
  });

  it('отчёт живёт рядом с тем, что уже считает потери', () => {
    const rep = codeOnly(read('core', 'media', 'mediaSendReport.ts'));
    expect(rep).toContain('export function batchSendReport(');
    expect(rep).toContain('export function decideMediaSend(');
    // Подпись предела — одна на приложение, а не своя у отчёта.
    expect(rep).toContain("import { formatLimit } from './uploadRoute';");
    expect(rep).not.toContain('formatByteSize(');
  });
});
