/**
 * Следы удалённых сообщений (v4.32.296).
 *
 * Три «очистить историю» — переписка, группа, всё сразу — стирали разное, и
 * самая сильная из них стирала меньше всех. Здесь перечень следов проверяется
 * поимённо: каждая колонка, которую когда-то забыли, названа отдельно, потому
 * что забыть её снова стоит ровно столько же — чужое сообщение на экране,
 * который показывают другим.
 */
import {
  CONVERSATION_TRACE_COLUMNS,
  GROUP_TRACE_COLUMNS,
  clearTracesSql,
} from '../purgeResidue';

describe('перечень следов', () => {
  it('личная переписка: превью, время, направление, счётчик, черновик, закрепление', () => {
    expect(Object.keys(CONVERSATION_TRACE_COLUMNS).sort()).toEqual([
      'draft_text',
      'last_message_at',
      'last_message_direction',
      'last_message_preview',
      'pinned_message_id',
      'unread_count',
    ]);
  });

  it('группа: и имя отправителя, и копия закреплённого текста', () => {
    // pinned_message_text — не ссылка, а копия: без неё баннер показывал
    // закреплённое сообщение и после очистки.
    expect(Object.keys(GROUP_TRACE_COLUMNS).sort()).toEqual([
      'last_message_at',
      'last_message_preview',
      'last_message_sender_name',
      'last_message_sender_pub',
      'mention_count',
      'pinned_message_id',
      'pinned_message_text',
      'unread_count',
    ]);
  });

  it('счётчики обнуляются, остальное становится NULL', () => {
    for (const [column, value] of Object.entries({
      ...CONVERSATION_TRACE_COLUMNS,
      ...GROUP_TRACE_COLUMNS,
    })) {
      expect(value).toBe(/count$|_at$/.test(column) ? '0' : 'NULL');
    }
  });
});

describe('запрос очистки', () => {
  it('накрывает каждую колонку из перечня', () => {
    const sql = clearTracesSql('conversations', 'profile');
    for (const [column, value] of Object.entries(CONVERSATION_TRACE_COLUMNS)) {
      expect(sql).toContain(`${column} = ${value}`);
    }
    const groupSql = clearTracesSql('groups', 'profile');
    for (const [column, value] of Object.entries(GROUP_TRACE_COLUMNS)) {
      expect(groupSql).toContain(`${column} = ${value}`);
    }
  });

  it('всегда ограничен профилем — соседний аккаунт не задевается', () => {
    for (const table of ['conversations', 'groups'] as const) {
      for (const scope of ['profile', 'row'] as const) {
        expect(clearTracesSql(table, scope)).toContain('WHERE owner_profile_id = ?');
      }
    }
  });

  it('одна переписка адресуется своим ключом', () => {
    expect(clearTracesSql('conversations', 'row')).toContain(
      'WHERE owner_profile_id = ? AND contact_pub_b64 = ?'
    );
    expect(clearTracesSql('groups', 'row')).toContain('WHERE owner_profile_id = ? AND id = ?');
  });

  it('очистка всего профиля не ограничена одной строкой', () => {
    expect(clearTracesSql('groups', 'profile')).not.toContain('AND id = ?');
    expect(clearTracesSql('conversations', 'profile')).not.toContain('AND contact_pub_b64 = ?');
  });

  it('обновляется именно та таблица', () => {
    expect(clearTracesSql('conversations', 'row').startsWith('UPDATE conversations SET ')).toBe(true);
    expect(clearTracesSql('groups', 'row').startsWith('UPDATE groups SET ')).toBe(true);
  });

  it('в запрос не подставляется ничего извне', () => {
    // Единственные параметры — `?`: значения приходят через runAsync.
    const sql = `${clearTracesSql('conversations', 'row')} ${clearTracesSql('groups', 'row')}`;
    expect(sql).not.toMatch(/'/);
    expect(sql.match(/\?/g)).toHaveLength(4);
  });
});
