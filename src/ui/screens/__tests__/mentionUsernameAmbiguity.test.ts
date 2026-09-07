/**
 * v4.32.615: `@имя` не открывает карточку того, кто просто назвался.
 *
 * `Contact.peerUsername` списан с конверта профиля собеседника: контакты
 * заполняют его тем, что человек сказал о себе сам, и с общим реестром имён
 * не сверяются никогда. Значит одно каноническое имя может лежать у двух
 * разных контактов, и «первый выигрывает» здесь означает «выигрывает тот,
 * кто назвался чужим именем».
 *
 * В `resolveMention` это закрыто (см. mentionResolve.test.ts), но экран групп
 * до этой версии спрашивал адресную книгу САМ и брал `find` — то есть мимо
 * общего правила. Проверки структурные: отрисовать экран в тесте нельзя, он
 * тянет SQLite и половину нативных модулей, а регрессия тихая — `find`
 * вернётся одной строкой, и всё соберётся.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** Тело `handleMentionPress` — от объявления до закрывающего `}, [`. */
function mentionHandler(name: string): string {
  const src = readFileSync(join(__dirname, '..', name), 'utf8');
  const start = src.indexOf('const handleMentionPress');
  expect(start).toBeGreaterThan(0);
  const end = src.indexOf('}, [', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, src.indexOf(');', end));
}

describe('экран групп не выбирает за человека по username', () => {
  const body = mentionHandler('GroupsScreen.tsx');

  it('поиск по адресной книге считает ключи, а не строки', () => {
    expect(body).toContain('.filter((c) => normalizeUsername(c.peerUsername) === canonical)');
    expect(body).toContain('.map((c) => c.peerPublicKey)');
    expect(body).toContain('ambiguousUsername = pubs.size > 1;');
    expect(body).toContain('byUsername = pubs.size === 1 ? [...pubs][0] : null;');
  });

  it('«первый выигрывает» из обработчика убран', () => {
    expect(body).not.toContain('.find((c) => normalizeUsername(c.peerUsername) === canonical)');
    expect(body).not.toMatch(/contact\?\.peerPublicKey/);
  });

  it('неоднозначность останавливает переход до сравнения с составом', () => {
    const stop = body.indexOf("showError(mentionMissText('ambiguous', bare))");
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(body.indexOf('const hits = byUsername'));
    // Текст берётся общий, а не свой: два разных объяснения одного отказа
    // разъезжаются при первой же правке.
    expect(body).not.toContain('носят несколько контактов —');
  });

  it('переписка спрашивает общее правило, а не адресную книгу напрямую', () => {
    const chat = mentionHandler('ChatScreen.tsx');
    expect(chat).toContain('resolveMentionTarget(bare,');
    expect(chat).not.toContain('listContactsFor(');
  });
});
