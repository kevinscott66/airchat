/**
 * Группы в резервной копии диалогов (v4.32.297).
 *
 * Копию подменяют файлом — она лежит в песочнице, но доступна через
 * adb/restore, — и её содержимое идёт прямо в SQLite. Поэтому проверяются
 * границы: что строка проходит целиком или не проходит вовсе, что сообщение не
 * попадёт в группу, которой в копии нет, и что роль участника нельзя выдумать.
 */
import {
  GROUP_MAX_ROWS,
  sanitizeGroupMemberRows,
  sanitizeGroupMessageRows,
  sanitizeGroupRows,
} from '../groupBackup';

const PUB = 'A'.repeat(43);
const OTHER_PUB = 'B'.repeat(44);

function group(over: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    name: 'enc2:zzz',
    description: null,
    avatar_cid: null,
    type: 'group',
    invite_token: null,
    is_admin: 1,
    member_count: 3,
    unread_count: 0,
    mention_count: 0,
    muted: 0,
    muted_until: null,
    pinned: 0,
    archived: 0,
    last_message_at: 1700000000000,
    last_message_preview: 'enc2:pre',
    last_message_sender_name: 'enc2:name',
    last_message_sender_pub: PUB,
    pinned_message_id: null,
    pinned_message_text: null,
    draft_text: null,
    disappear_after_ms: null,
    disappear_set_at: null,
    slow_mode_seconds: 0,
    admin_only_posting: 0,
    admin_only_pinning: 1,
    anonymous_posting: 0,
    require_approval: 0,
    created_at: 1699000000000,
    ...over,
  };
}

function message(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    group_id: 'g1',
    sender_pub_b64: PUB,
    sender_name: 'enc2:sender',
    text: 'enc2:text',
    media_cids: null,
    reply_to_id: null,
    reply_to_preview: null,
    reactions: null,
    created_at: 1700000000000,
    edited_at: null,
    starred: 0,
    view_count: 0,
    seen_by: null,
    ...over,
  };
}

const IDS = new Set(['g1']);

describe('группы из копии', () => {
  it('целая строка проходит как есть', () => {
    const { rows, dropped } = sanitizeGroupRows([group()]);
    expect(dropped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'g1', name: 'enc2:zzz', type: 'group', member_count: 3 });
  });

  it('owner_profile_id из файла не переносится — его ставит импорт', () => {
    const { rows } = sanitizeGroupRows([group({ owner_profile_id: 7 })]);
    expect(rows[0]).not.toHaveProperty('owner_profile_id');
  });

  it('канал и супергруппа — тоже свои типы, выдуманный тип отбрасывается', () => {
    expect(sanitizeGroupRows([group({ type: 'channel' })]).rows).toHaveLength(1);
    expect(sanitizeGroupRows([group({ type: 'supergroup' })]).rows).toHaveLength(1);
    expect(sanitizeGroupRows([group({ type: 'secret' })]).rows).toHaveLength(0);
  });

  it('группа без названия не проходит — открывать её пришлось бы вслепую', () => {
    expect(sanitizeGroupRows([group({ name: '' })]).rows).toHaveLength(0);
    expect(sanitizeGroupRows([group({ name: null })]).rows).toHaveLength(0);
  });

  it('«только админы пишут» строкой не подделать', () => {
    // Строка "0" в SQLite истинна: пропустив её, группа осталась бы открытой
    // для всех при выключенном на экране переключателе.
    expect(sanitizeGroupRows([group({ admin_only_posting: '0' })]).rows).toHaveLength(0);
    expect(sanitizeGroupRows([group({ admin_only_posting: true })]).rows[0].admin_only_posting).toBe(1);
  });

  it('без колонки admin_only_pinning остаётся «закрепляют только админы»', () => {
    const { rows } = sanitizeGroupRows([group({ admin_only_pinning: undefined })]);
    expect(rows[0].admin_only_pinning).toBe(1);
  });

  it('таймер самоуничтожения дольше года — подмена', () => {
    const year = 365 * 24 * 60 * 60 * 1000;
    expect(sanitizeGroupRows([group({ disappear_after_ms: year })]).rows).toHaveLength(1);
    expect(sanitizeGroupRows([group({ disappear_after_ms: year + 1 })]).rows).toHaveLength(0);
    expect(sanitizeGroupRows([group({ disappear_after_ms: -1 })]).rows).toHaveLength(0);
  });

  it('аватар-дескриптор не роняет строку группы целиком', () => {
    // v4.32.304. На телефоне IPFS выключен, и в avatar_cid лежит не CID (46
    // символов), а `nb:`-дескриптор: URL до 512 символов, ключ, MIME, blob-id —
    // и с этой версии ещё и enc2-шифротекстом поверх. Прежний потолок в 256
    // отбрасывал не аватар, а ВСЮ строку: `dropped++; continue`. То есть копия
    // молча теряла бы группу из-за картинки.
    const nb = 'enc2:' + 'z'.repeat(1_000);
    const ok = sanitizeGroupRows([group({ avatar_cid: nb })]);
    expect(ok.rows).toHaveLength(1);
    expect(ok.rows[0].avatar_cid).toBe(nb);
    // Потолок всё же есть: колонка идёт прямо в БД, и это по-прежнему файл
    // из-под adb.
    expect(sanitizeGroupRows([group({ avatar_cid: 'z'.repeat(2_049) })]).rows).toHaveLength(0);
  });

  it('чужой ключ последнего отправителя должен быть ключом', () => {
    expect(sanitizeGroupRows([group({ last_message_sender_pub: 'short' })]).rows).toHaveLength(0);
    expect(sanitizeGroupRows([group({ last_message_sender_pub: null })]).rows).toHaveLength(1);
  });

  it('медленный режим ограничен сутками, счётчики — не отрицательные', () => {
    expect(sanitizeGroupRows([group({ slow_mode_seconds: 999_999 })]).rows[0].slow_mode_seconds).toBe(86_400);
    expect(sanitizeGroupRows([group({ unread_count: -5 })]).rows).toHaveLength(0);
  });

  it('дубль по id отбрасывается — какая строка настоящая, неизвестно', () => {
    const { rows, dropped } = sanitizeGroupRows([group(), group({ name: 'enc2:other' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('enc2:zzz');
    expect(dropped).toBe(1);
  });

  it('groups сверх предела считаются отброшенными, а не молча теряются', () => {
    const many = Array.from({ length: GROUP_MAX_ROWS + 3 }, (_, i) => group({ id: `g${i}` }));
    const { rows, dropped } = sanitizeGroupRows(many);
    expect(rows).toHaveLength(GROUP_MAX_ROWS);
    expect(dropped).toBe(3);
  });

  it('не массив — пустой результат без падения', () => {
    expect(sanitizeGroupRows(null)).toEqual({ rows: [], dropped: 0 });
    expect(sanitizeGroupRows({ id: 'g1' })).toEqual({ rows: [], dropped: 0 });
  });
});

describe('сообщения групп из копии', () => {
  it('сообщение к группе, которой в копии нет, отбрасывается', () => {
    const { rows, dropped } = sanitizeGroupMessageRows([message({ group_id: 'ghost' })], IDS);
    expect(rows).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('шифротекст едет как есть, пустой текст — это вложение без подписи', () => {
    const { rows } = sanitizeGroupMessageRows([message(), message({ id: 'm2', text: '' })], IDS);
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe('enc2:text');
  });

  it('отправитель без ключа не проходит', () => {
    expect(sanitizeGroupMessageRows([message({ sender_pub_b64: 'nope' })], IDS).rows).toHaveLength(0);
    expect(sanitizeGroupMessageRows([message({ sender_pub_b64: OTHER_PUB })], IDS).rows).toHaveLength(1);
  });

  it('сообщению нужно время создания', () => {
    expect(sanitizeGroupMessageRows([message({ created_at: null })], IDS).rows).toHaveLength(0);
    expect(sanitizeGroupMessageRows([message({ created_at: 'вчера' })], IDS).rows).toHaveLength(0);
  });

  it('текст длиннее предела отбрасывает строку целиком, а не режет её', () => {
    // Обрезанный base64 не расшифруется никогда — сообщение вернулось бы
    // пустым и без следа, что оно было.
    const { rows } = sanitizeGroupMessageRows([message({ text: 'x'.repeat(96_001) })], IDS);
    expect(rows).toHaveLength(0);
  });

  it('дубль по id отбрасывается', () => {
    const { rows } = sanitizeGroupMessageRows([message(), message({ text: 'enc2:fake' })], IDS);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('enc2:text');
  });

  it('колонок из старой копии может не быть', () => {
    const old = message();
    delete (old as Record<string, unknown>).starred;
    delete (old as Record<string, unknown>).view_count;
    delete (old as Record<string, unknown>).seen_by;
    const { rows } = sanitizeGroupMessageRows([old], IDS);
    expect(rows[0]).toMatchObject({ starred: 0, view_count: 0, seen_by: null });
  });
});

describe('состав групп из копии', () => {
  it('участник чужой группы отбрасывается', () => {
    const { rows } = sanitizeGroupMemberRows(
      [{ group_id: 'ghost', peer_pub_b64: PUB, role: 'member', display_name: null, joined_at: 1 }],
      IDS
    );
    expect(rows).toHaveLength(0);
  });

  it('роль берётся только из известных', () => {
    for (const role of ['owner', 'admin', 'member', 'restricted', 'banned']) {
      const { rows } = sanitizeGroupMemberRows(
        [{ group_id: 'g1', peer_pub_b64: PUB, role, display_name: null, joined_at: 1 }],
        IDS
      );
      expect(rows).toHaveLength(1);
    }
    const { rows } = sanitizeGroupMemberRows(
      [{ group_id: 'g1', peer_pub_b64: PUB, role: 'superadmin', display_name: null, joined_at: 1 }],
      IDS
    );
    expect(rows).toHaveLength(0);
  });

  it('один и тот же участник дважды — только первый', () => {
    const { rows, dropped } = sanitizeGroupMemberRows(
      [
        { group_id: 'g1', peer_pub_b64: PUB, role: 'member', display_name: null, joined_at: 1 },
        { group_id: 'g1', peer_pub_b64: PUB, role: 'owner', display_name: null, joined_at: 2 },
      ],
      IDS
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('member');
    expect(dropped).toBe(1);
  });

  it('время вступления из будущего дальше 2100 года — подмена', () => {
    const { rows } = sanitizeGroupMemberRows(
      [{ group_id: 'g1', peer_pub_b64: PUB, role: 'member', display_name: null, joined_at: 5_000_000_000_000 }],
      IDS
    );
    expect(rows).toHaveLength(0);
  });
});
