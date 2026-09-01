/**
 * Настройки переписок в резервной копии (v4.32.295).
 *
 * До этой версии копия хранила только сообщения, а строки conversations
 * собирались заново — и таймер самоуничтожения после восстановления молча
 * становился «никогда», архив возвращал спрятанное в общий список, тишина
 * снималась. Здесь проверяются границы разбора: файл лежит в песочнице, но
 * подменить его через adb/restore можно, и эти значения идут прямо в БД.
 */
import {
  CONVERSATION_META_MAX_ROWS,
  isColorTag,
  sanitizeConversationMetaRows,
} from '../conversationMeta';

const PUB = 'A'.repeat(43);
const PUB2 = 'B'.repeat(44);

function row(over: Record<string, unknown> = {}) {
  return {
    contact_pub_b64: PUB,
    unread_count: 0,
    draft_text: null,
    pinned: 0,
    archived: 0,
    muted: 0,
    muted_until: null,
    pinned_message_id: null,
    disappear_after_ms: null,
    disappear_set_at: null,
    color_tag: null,
    ...over,
  };
}

describe('что проходит в базу', () => {
  it('настройки переписки возвращаются как есть', () => {
    const { rows, dropped } = sanitizeConversationMetaRows([
      row({ pinned: 1, archived: 1, muted: 1, disappear_after_ms: 3600_000, color_tag: '#e74c3c' }),
    ]);
    expect(dropped).toBe(0);
    expect(rows[0]).toMatchObject({
      contact_pub_b64: PUB,
      pinned: 1,
      archived: 1,
      muted: 1,
      disappear_after_ms: 3600_000,
      color_tag: '#e74c3c',
    });
  });

  it('черновик едет шифротекстом и не разбирается', () => {
    const draft = `enc2:${'x'.repeat(100)}`;
    expect(sanitizeConversationMetaRows([row({ draft_text: draft })]).rows[0].draft_text).toBe(draft);
  });

  it('булевы флаги из чужого сериализатора принимаются', () => {
    const { rows } = sanitizeConversationMetaRows([row({ pinned: true, muted: false })]);
    expect(rows[0].pinned).toBe(1);
    expect(rows[0].muted).toBe(0);
  });

  it('не массив — пустой результат, а не исключение', () => {
    expect(sanitizeConversationMetaRows(null).rows).toEqual([]);
    expect(sanitizeConversationMetaRows({ a: 1 }).rows).toEqual([]);
    expect(sanitizeConversationMetaRows('строка').rows).toEqual([]);
  });
});

describe('что отбрасывается', () => {
  it('строка целиком, а не по частям', () => {
    // Применить половину чужой настройки безопасности хуже, чем не применять:
    // «исчезают через час» с потерянным disappear_set_at — уже другое решение.
    const { rows, dropped } = sanitizeConversationMetaRows([
      row({ disappear_after_ms: 3600_000, disappear_set_at: 'вчера' }),
      row({ contact_pub_b64: PUB2, pinned: 1 }),
    ]);
    expect(dropped).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].contact_pub_b64).toBe(PUB2);
  });

  it('чужой или испорченный ключ переписки', () => {
    const bad = [
      row({ contact_pub_b64: 'коротко' }),
      row({ contact_pub_b64: 'A'.repeat(200) }),
      row({ contact_pub_b64: 42 }),
      null,
      'строка',
      [],
    ];
    const { rows, dropped } = sanitizeConversationMetaRows(bad);
    expect(rows).toHaveLength(0);
    expect(dropped).toBe(bad.length);
  });

  it('флаг не 0/1', () => {
    expect(sanitizeConversationMetaRows([row({ pinned: 7 })]).rows).toHaveLength(0);
    expect(sanitizeConversationMetaRows([row({ archived: 'да' })]).rows).toHaveLength(0);
  });

  it('таймер самоуничтожения вне разумных границ', () => {
    expect(sanitizeConversationMetaRows([row({ disappear_after_ms: -1 })]).rows).toHaveLength(0);
    expect(sanitizeConversationMetaRows([row({ disappear_after_ms: 1e15 })]).rows).toHaveLength(0);
    expect(sanitizeConversationMetaRows([row({ disappear_after_ms: NaN })]).rows).toHaveLength(0);
    // Ноль — это «выключено», он законен.
    expect(sanitizeConversationMetaRows([row({ disappear_after_ms: 0 })]).rows).toHaveLength(1);
  });

  it('метка не цвета — иначе для неё не назвать папку', () => {
    expect(sanitizeConversationMetaRows([row({ color_tag: 'красный' })]).rows).toHaveLength(0);
    expect(sanitizeConversationMetaRows([row({ color_tag: 42 })]).rows).toHaveLength(0);
    expect(sanitizeConversationMetaRows([row({ color_tag: '#e74c3c' })]).rows).toHaveLength(1);
  });

  it('переросший черновик и закреплённое сообщение', () => {
    expect(sanitizeConversationMetaRows([row({ draft_text: 'x'.repeat(96_001) })]).rows).toHaveLength(0);
    expect(sanitizeConversationMetaRows([row({ pinned_message_id: 'x'.repeat(129) })]).rows).toHaveLength(0);
  });

  it('счётчик непрочитанных приводится к целому и ограничивается', () => {
    expect(sanitizeConversationMetaRows([row({ unread_count: 3.7 })]).rows[0].unread_count).toBe(3);
    expect(sanitizeConversationMetaRows([row({ unread_count: 1e12 })]).rows[0].unread_count).toBe(1_000_000);
    expect(sanitizeConversationMetaRows([row({ unread_count: -5 })]).rows).toHaveLength(0);
  });

  it('вторая строка про ту же переписку — неизвестно, какая настоящая', () => {
    const { rows, dropped } = sanitizeConversationMetaRows([
      row({ pinned: 1 }),
      row({ pinned: 0, archived: 1 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pinned).toBe(1);
    expect(dropped).toBe(1);
  });

  it('файл с миллионом строк не проходит целиком', () => {
    const many = Array.from({ length: CONVERSATION_META_MAX_ROWS + 5 }, (_, i) =>
      row({ contact_pub_b64: `${i}`.padStart(43, 'C') })
    );
    const { rows, dropped } = sanitizeConversationMetaRows(many);
    expect(rows).toHaveLength(CONVERSATION_META_MAX_ROWS);
    expect(dropped).toBe(5);
  });
});

describe('isColorTag', () => {
  it('принимает цвета и отвергает всё остальное', () => {
    expect(isColorTag('#e74c3c')).toBe(true);
    expect(isColorTag('#FFF')).toBe(true);
    expect(isColorTag('#e74c3cff')).toBe(true);
    expect(isColorTag('e74c3c')).toBe(false);
    expect(isColorTag('#zzzzzz')).toBe(false);
    expect(isColorTag('#e74c3c; DROP TABLE conversations')).toBe(false);
    expect(isColorTag(null)).toBe(false);
  });
});
