/**
 * Полный список того, что лежит в БД шифртекстом.
 *
 * v4.32.279 завёл его потому, что смена DEK перешифровывала только то, что
 * было зашифровано в день, когда миграцию писали: всё добавленное позже
 * оставалось под старым ключом и после смены расшифровывалось в пустую строку —
 * вся переписка в группах молча превращалась в пустые сообщения, без ошибки и
 * без возврата.
 *
 * v4.32.298 вынес список из local.ts сюда: он не только перечень для
 * перешифровки, но и ответ на вопрос «что в этой базе видно тому, кто её
 * открыл». Проверять его в тестах SQLite не нужен, а забывается он ровно так
 * же, как забылся `group_members.display_name`: имя отправителя в сообщении
 * зашифровали в v4.32.285 именно затем, чтобы по одной колонке не читался
 * состав группы, — а сам состав всё это время лежал рядом открытым текстом,
 * причём полностью и независимо от того, писал человек хоть раз или нет.
 *
 * Добавляя зашифрованную колонку, её дописывают сюда — и в тест, поимённо.
 *
 * Здесь перечислена ТОЛЬКО главная база. У ленты своя SQLite на профиль
 * (`airchat_feed_p<id>.db`), и её список живёт в feedAtRest.ts: дописать
 * feed-таблицы сюда было бы не просто бесполезно, а вредно — перешифровка
 * ходит по главной базе и молча пропустила бы их как несуществующие,
 * оставив ощущение, что лента учтена.
 */

export type AtRestColumnSpec = { table: string; columns: readonly string[] };

export const AT_REST_COLUMNS: ReadonlyArray<AtRestColumnSpec> = [
  // v4.32.302: reactions и seen_by — не текст сообщения, но по ним читается то,
  // ради чего текст и прячут: кто чем ответил и кто что прочитал. У сторис тот
  // же список зовётся viewed_by и шифруется здесь же с самого начала.
  { table: 'chat_messages', columns: ['text', 'media_cids', 'reply_to_preview', 'reactions'] },
  {
    table: 'group_messages',
    columns: ['text', 'media_cids', 'reply_to_preview', 'sender_name', 'reactions', 'seen_by'],
  },
  { table: 'conversations', columns: ['draft_text', 'last_message_preview'] },
  {
    table: 'groups',
    columns: [
      'name', 'description', 'draft_text',
      'last_message_preview', 'last_message_sender_name', 'pinned_message_text',
      // v4.32.304: avatar_cid — на телефоне это не IPFS-CID, а `nb:`-дескриптор,
      // и он несёт ключ расшифровки файла аватара (blobRef.ts).
      'avatar_cid',
      // v4.32.303: invite_token — не данные, а право: кто его прочитал, тот
      // собрал действующую ссылку в группу. Здесь он с первого дня, поэтому
      // разовой миграции ему не нужно — открытым текстом он не лежал никогда.
      'invite_token',
    ],
  },
  // v4.32.298: состав группы — имена участников, которые человек видит в
  // списке. Ровно та же строка, что и sender_name в его сообщении.
  { table: 'group_members', columns: ['display_name'] },
  { table: 'stories', columns: ['media_uri', 'text', 'viewed_by'] },
  // v4.32.576: альбомы историй. Название альбома человек пишет сам, подпись
  // истории — тем более; media_file — имя копии на диске, тот же адрес, что и
  // stories.media_uri, только переживший сутки.
  { table: 'story_albums', columns: ['title'] },
  { table: 'story_album_items', columns: ['media_file', 'media_cid', 'text'] },
  { table: 'outbox', columns: ['payload'] },
  // v4.32.283: написанное человеком, но ещё не ставшее сообщением.
  // v4.32.304: sender_name — то же имя, что и в group_messages.sender_name.
  // Колонку завели позже text/media_cids и шифровать забыли, поэтому строка
  // читалась как «в группу g-… напишет Аня» при зашифрованном содержимом.
  { table: 'scheduled_messages', columns: ['text', 'media_cids', 'sender_name'] },
  { table: 'quick_replies', columns: ['text'] },
  { table: 'group_join_requests', columns: ['requester_name', 'message'] },
];

/**
 * Имена таблиц и колонок подставляются в SQL напрямую — параметром имя не
 * передать. Поэтому они обязаны быть идентификаторами и ничем больше.
 */
export function isSafeSqlIdentifier(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/i.test(name);
}
