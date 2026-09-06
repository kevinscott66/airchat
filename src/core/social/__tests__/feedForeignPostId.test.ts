/**
 * Чужой номер публикации и вложения (v4.32.614).
 *
 * Номер поста придумывает отправитель, а имена ключей вложений собраны из
 * одного лишь номера: `feed_inline_media:<postId>:<i>`. Строку публикации
 * `savePost` подменить не даёт — это INSERT OR IGNORE, — но байты фотографий и
 * документов лежат не в строке. Поэтому любой, чей подписанный конверт мы
 * принимаем (а по ретрансляции это кто угодно, не только контакт), мог прислать
 * свой `feed_post` с ЧУЖИМ номером: запись оставалась прежней, а картинки под
 * ней подменялись его собственными. У репоста было хуже вдвое — там байты
 * писались ДО `savePost`, то есть проверка автора не спасала бы даже случайно.
 *
 * Здесь держится и сама проверка, и её место: она обязана стоять раньше первой
 * записи байтов, иначе от неё нет никакого толку.
 */
import fs from 'fs';
import path from 'path';

const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

/** Тело одной ветки switch: от `case '<name>': {` до строки с закрывающей скобкой той же глубины. */
function caseBody(src: string, name: string): string {
  const head = `      case '${name}': {`;
  const start = src.indexOf(head);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n      }\n', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('приём публикации с уже занятым номером', () => {
  for (const kind of ['feed_post', 'feed_repost']) {
    it(`${kind}: автор сверяется до того, как что-либо записано`, () => {
      const body = caseBody(SERVICE, kind);
      const guard = body.indexOf('await s.postWriteGuard(payload.postId, payload.authorDid)');
      expect(guard).toBeGreaterThanOrEqual(0);

      // Отказ — это выход из ветки, а не запись в журнал и продолжение.
      expect(body.slice(guard, guard + 400)).toContain("if (guard !== 'ok')");
      expect(body.slice(guard, guard + 400)).toContain('break;');

      // Ни байтов вложения, ни строки поста раньше сверки быть не может.
      const write = body.indexOf('kvSetInlineAttachment');
      expect(write).toBeGreaterThan(guard);
      const save = body.indexOf('await s.savePost(');
      expect(save).toBeGreaterThan(guard);
    });
  }
});
