/**
 * Что в базе лежит шифртекстом (v4.32.298).
 *
 * Список нужен двум разным вещам сразу: перешифровке при смене DEK и ответу на
 * вопрос «что видно тому, кто открыл эту базу». Забывается он молча — как
 * забылся `group_members.display_name`: имя отправителя в сообщении зашифровали
 * в v4.32.285 ровно затем, чтобы по одной колонке не читался состав группы, а
 * сам состав лежал рядом открытым текстом. Поэтому каждая колонка названа здесь
 * поимённо: убрать её из перечня, не заметив, теперь нельзя.
 */
import { AT_REST_COLUMNS, isSafeSqlIdentifier } from '../atRestColumns';

function columnsOf(table: string): readonly string[] {
  return AT_REST_COLUMNS.find((s) => s.table === table)?.columns ?? [];
}

describe('перечень шифруемых колонок', () => {
  it('переписка: текст, вложения, цитата и реакции', () => {
    expect([...columnsOf('chat_messages')].sort()).toEqual([
      'media_cids',
      'reactions',
      'reply_to_preview',
      'text',
    ]);
  });

  it('сообщения групп: то же плюс имя отправителя и кто прочитал', () => {
    // v4.32.302: seen_by — тот же список, что viewed_by у сторис, только про
    // сообщения группы. По нему видно, кто в разговоре молча читает.
    expect([...columnsOf('group_messages')].sort()).toEqual([
      'media_cids',
      'reactions',
      'reply_to_preview',
      'seen_by',
      'sender_name',
      'text',
    ]);
  });

  it('состав группы: имя участника', () => {
    // v4.32.298. По этой колонке читался весь состав группы — тот самый, ради
    // которого шифровали sender_name, — и не зависел от того, писал человек
    // хоть раз или молча состоит.
    expect([...columnsOf('group_members')]).toEqual(['display_name']);
  });

  it('группа: название, описание, черновик, превью, закреплённое, токен и аватар', () => {
    // v4.32.303: invite_token — секрет пригласительной ссылки. Единственная
    // колонка в этом перечне, которая хранит не написанное человеком, а право:
    // прочитавший её собирает действующую ссылку в группу.
    // v4.32.304: avatar_cid — тоже не текст: `nb:`-дескриптор несёт ключ
    // расшифровки файла аватара.
    expect([...columnsOf('groups')].sort()).toEqual([
      'avatar_cid',
      'description',
      'draft_text',
      'invite_token',
      'last_message_preview',
      'last_message_sender_name',
      'name',
      'pinned_message_text',
    ]);
  });

  it('переписка в списке чатов: черновик и превью', () => {
    expect([...columnsOf('conversations')].sort()).toEqual(['draft_text', 'last_message_preview']);
  });

  it('написанное, но ещё не отправленное — тоже', () => {
    expect([...columnsOf('outbox')]).toEqual(['payload']);
    // sender_name здесь с v4.32.304: колонку завели позже остальных, и она
    // одна осталась открытой — «в группу g-… напишет Аня» при шифрованном тексте.
    expect([...columnsOf('scheduled_messages')].sort()).toEqual([
      'media_cids',
      'sender_name',
      'text',
    ]);
    expect([...columnsOf('quick_replies')]).toEqual(['text']);
  });

  it('заявка на вступление: имя и сообщение просящего', () => {
    expect([...columnsOf('group_join_requests')].sort()).toEqual(['message', 'requester_name']);
  });

  it('истории: и просмотревшие тоже', () => {
    expect([...columnsOf('stories')].sort()).toEqual(['media_uri', 'text', 'viewed_by']);
  });

  it('альбомы историй: название альбома, подпись и адрес копии', () => {
    // v4.32.576. Альбом — это то, что человек решил оставить после суток:
    // название он придумывает сам, а media_file указывает на файл, который
    // теперь живёт долго. Открытым текстом здесь читался бы и список тем, и
    // то, где лежат снимки.
    expect([...columnsOf('story_albums')]).toEqual(['title']);
    expect([...columnsOf('story_album_items')].sort()).toEqual(['media_file', 'text']);
  });
});

describe('перечень как источник SQL', () => {
  it('таблица названа один раз — иначе часть колонок молча потерялась бы', () => {
    const tables = AT_REST_COLUMNS.map((s) => s.table);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('внутри таблицы колонки не повторяются', () => {
    for (const spec of AT_REST_COLUMNS) {
      expect(new Set(spec.columns).size).toBe(spec.columns.length);
    }
  });

  it('имена — идентификаторы: их подставляют в SQL напрямую', () => {
    // Параметром имя таблицы не передать, поэтому единственная защита здесь —
    // то, что имена остаются именами.
    for (const spec of AT_REST_COLUMNS) {
      expect(isSafeSqlIdentifier(spec.table)).toBe(true);
      expect(spec.columns.length).toBeGreaterThan(0);
      for (const column of spec.columns) {
        expect(isSafeSqlIdentifier(column)).toBe(true);
      }
    }
  });

  it('идентификатором не считается ничего с кавычкой, пробелом или точкой с запятой', () => {
    for (const bad of ['drop table', 'a;b', "a'b", 'a-b', '1a', '', 'a.b', 'a)b']) {
      expect(isSafeSqlIdentifier(bad)).toBe(false);
    }
  });
});
