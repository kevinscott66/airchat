/**
 * Чем подписано отложенное сообщение группы, когда своё же имя не прочиталось
 * (v4.32.596).
 *
 * Имя отправителя лежит в `scheduled_messages.sender_name` зашифрованным
 * (v4.32.304). Читалось оно двумя состояниями —
 * `nameOrNull(decryptAtRestNullable(...))`, — и не открывшийся ключом столбец
 * приходил тем же `null`, что и «имени не было». Подпись собиралась как
 * `msg.senderName || '?'`, то есть уходила ВСЕЙ группе знаком вопроса, а
 * следом такой же ложилась в свою историю (`insertGroupMessage`) и в превью
 * списка (`touchGroupConversation`).
 *
 * Поправить это потом нечем: сообщение отправлено, строка расписания удалена.
 * При этом подписывается собственное сообщение — как автора зовут сейчас, мы
 * знаем и без базы. Поэтому здесь не отказ от отправки (текст прочитался, и
 * держать готовое сообщение из-за подписи несоразмерно), а правило подписи.
 *
 * Проверяется чистым модулем: без базы, без ключей, без сети. Сам
 * `scheduledMessages.ts` тянет uuid, который jest не преобразует, — поэтому
 * его проход читается как текст.
 */
import fs from 'fs';
import path from 'path';

import { scheduledSenderLabel } from '../scheduledDispatch';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const DISPATCH = () => fs.readFileSync(path.join(__dirname, '..', 'scheduledDispatch.ts'), 'utf8');
const RUNNER = () => fs.readFileSync(path.join(__dirname, '..', 'scheduledMessages.ts'), 'utf8');

/** Кусок файла между двумя опорами — чтобы утверждение не ловило соседей. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('правило подписи', () => {
  it('записанное имя сильнее нынешнего: его автор выбрал сам', () => {
    expect(scheduledSenderLabel({ senderName: 'Аня' }, 'Анна Петровна')).toBe('Аня');
  });

  it('непрочитанное имя заменяется нынешним, а не знаком вопроса', () => {
    expect(scheduledSenderLabel({ senderName: null, senderNameUnreadable: true }, 'Аня')).toBe('Аня');
  });

  it('непрочитанное имя не перебивается остатком строки в столбце', () => {
    // Пустая строка от неудачной расшифровки не должна пройти как имя.
    expect(scheduledSenderLabel({ senderName: '', senderNameUnreadable: true }, 'Аня')).toBe('Аня');
  });

  it('имени не было — тоже подписываемся нынешним', () => {
    expect(scheduledSenderLabel({ senderName: null }, 'Аня')).toBe('Аня');
  });

  it('пробелы именем не считаются', () => {
    expect(scheduledSenderLabel({ senderName: '   ' }, '  Аня ')).toBe('Аня');
  });

  it('неизвестно ни то, ни другое — только тогда «?»', () => {
    expect(scheduledSenderLabel({ senderName: null, senderNameUnreadable: true }, null)).toBe('?');
    expect(scheduledSenderLabel({}, undefined)).toBe('?');
  });

  it('пометка наружу не уходит', () => {
    const label = scheduledSenderLabel({ senderName: null, senderNameUnreadable: true }, 'Аня');
    expect(label).not.toContain('прочитать');
  });
});

describe('чтение строки расписания', () => {
  it('имя отправителя читается состоянием', () => {
    const body = slice(LOCAL(), 'function rowToScheduled(', 'export async function listDueScheduledMessages(');
    expect(body).toContain('readNameCell(r.sender_name ?? null, dek)');
    expect(body).toContain('senderNameUnreadable: senderCell.unreadable,');
    expect(body).not.toContain('nameOrNull(decryptAtRestNullable(r.sender_name');
  });

  it('строка расписания несёт признак непрочитанного имени', () => {
    const type = slice(LOCAL(), 'export type ScheduledMessage = {', 'export async function insertScheduledMessage(');
    expect(type).toMatch(/^ {2}senderNameUnreadable\?: boolean;$/m);
  });

  it('запись о признаке не знает: он про чтение', () => {
    const write = slice(LOCAL(), 'export async function insertScheduledMessage(', 'function rowToScheduled(');
    expect(write).not.toContain('senderNameUnreadable');
  });
});

describe('проход планировщика', () => {
  it('подпись собирается общим правилом, а не выражением на месте', () => {
    const src = RUNNER();
    expect(src).toContain('const senderLabel = scheduledSenderLabel(msg, ownName);');
    expect(src).not.toContain("msg.senderName || '?'");
  });

  it('нынешнее имя спрашивается один раз на проход и по тому же профилю', () => {
    const src = RUNNER();
    expect(src).toContain('const ownName = await getOwnDisplayNameFor(pid);');
    // Ровно один вызов: внутри цикла его быть не должно — иначе имя
    // спрашивалось бы на каждую строку расписания.
    expect(src.split('getOwnDisplayNameFor(').length - 1).toBe(1);
    expect(src).toMatch(/^import \{ getOwnDisplayNameFor \} from '\.\.\/identity\/ownProfile';$/m);
  });

  it('решение об отправке правилом подписи не тронуто', () => {
    // Непрочитанный ТЕКСТ по-прежнему держит строку: подпись — не текст.
    expect(DISPATCH()).toContain("if (cells.text === 'unreadable') return 'text_unreadable';");
    expect(RUNNER()).toContain('const verdict = decideScheduledSend(msg);');
  });

  it('модуль решения остаётся без импортов', () => {
    expect(DISPATCH()).not.toMatch(/^import /m);
  });
});
