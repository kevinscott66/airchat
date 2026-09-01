import { reactionScopeSql, type ReactionScope } from '../reactionScope';

const MSG = 'msg-1';
const PID = 7;

const groupScope: ReactionScope = { group: true, groupId: 'g1', ownerProfileId: PID };
const dmScope: ReactionScope = { group: false, contactPubB64: 'Qm9i', ownerProfileId: PID };

describe('reactionScopeSql', () => {
  it('реакция в группе ищется по группе, а не по одному id', () => {
    // Права проверялись по groupId конверта, а строка правилась по msgId:
    // участник группы А отмечался в сообщении группы Б, зная только его id.
    const sql = reactionScopeSql(MSG, groupScope);
    expect(sql.table).toBe('group_messages');
    expect(sql.where).toContain('group_id = ?');
    expect(sql.params).toEqual([MSG, PID, 'g1']);
  });

  it('реакция в переписке ищется по собеседнику', () => {
    const sql = reactionScopeSql(MSG, dmScope);
    expect(sql.table).toBe('chat_messages');
    expect(sql.where).toContain('contact_pub_b64 = ?');
    expect(sql.params).toEqual([MSG, PID, 'Qm9i']);
  });

  it('профиль входит в условие в обеих ветках', () => {
    // Личная ветка искала строку вообще без owner_profile_id — реакция ложилась
    // на сообщение любого профиля устройства.
    for (const scope of [groupScope, dmScope]) {
      const sql = reactionScopeSql(MSG, scope);
      expect(sql.where).toContain('owner_profile_id = ?');
      expect(sql.params[1]).toBe(PID);
    }
  });

  it('число заполнителей совпадает с числом параметров', () => {
    // Расхождение здесь молча сдвигает всё условие: SQLite подставит параметры
    // не в те места, и запрос начнёт находить чужие строки.
    for (const scope of [groupScope, dmScope]) {
      const sql = reactionScopeSql(MSG, scope);
      expect((sql.where.match(/\?/g) ?? []).length).toBe(sql.params.length);
    }
  });

  it('в запрос не подставляется ни одно значение — только заполнители', () => {
    const sql = reactionScopeSql("' OR 1=1 --", {
      group: true,
      groupId: "' OR 1=1 --",
      ownerProfileId: PID,
    });
    expect(sql.where).not.toContain('1=1');
    expect(sql.params[0]).toBe("' OR 1=1 --");
  });

  it('id сообщения всегда первый параметр', () => {
    for (const scope of [groupScope, dmScope]) {
      expect(reactionScopeSql(MSG, scope).params[0]).toBe(MSG);
    }
  });
});
