import * as fs from 'fs';
import * as path from 'path';
import { ownerPidByDid, type ProfileIdentity } from '../ownerProfile';

/**
 * Раунд 457: входящее сообщение больше не попадает в чужой профиль.
 *
 * MessagingService создаётся под пару ключей, а номер профиля читал глобальный
 * «активный». На приёме между расшифровкой конверта и записью в базу стоят
 * await'ы — при первом сообщении от незнакомца это полная пересборка подписок,
 * секунды. Переключение профиля в это окно давало запись сообщения, которое
 * расшифровано ключом личного профиля, в переписку рабочего: там же превью
 * диалога и счётчик непрочитанных. Профили заводят ровно затем, чтобы этого
 * не было.
 */

const MSG = fs.readFileSync(path.join(__dirname, '..', '..', 'social', 'messaging.ts'), 'utf8');

function bodyOf(src: string, head: string): string {
  const start = src.indexOf(head);
  if (start < 0) return '';
  const end = src.indexOf('\n  }', start);
  return end < 0 ? '' : src.slice(start, end);
}

const A: ProfileIdentity = { id: 1, did: 'did:key:aaa' };
const B: ProfileIdentity = { id: 2, did: 'did:key:bbb' };

describe('профиль определяется по ключу, а не по тому, что активно', () => {
  test('активен наш — берём его', () => {
    expect(ownerPidByDid(A.did, A, () => [A, B])).toBe(1);
  });

  test('активен чужой — всё равно наш', () => {
    expect(ownerPidByDid(A.did, B, () => [A, B])).toBe(1);
  });

  test('профили ещё не подняты — ответа нет, а не «первый»', () => {
    expect(ownerPidByDid(A.did, null, () => [A, B])).toBeNull();
  });

  test('нашего профиля в списке нет — ответа нет', () => {
    expect(ownerPidByDid('did:key:ccc', B, () => [A, B])).toBeNull();
  });

  test('дорогой список не строится, когда активен наш профиль', () => {
    // getAllProfiles выводит ключевую пару на каждый профиль (PBKDF2, 2048
    // итераций) — на приёме сообщения это заметно.
    let built = 0;
    ownerPidByDid(A.did, A, () => {
      built++;
      return [A, B];
    });
    expect(built).toBe(0);
  });
});

describe('служба переписки спрашивает свой профиль, а не активный', () => {
  test('ответ запоминается — измениться посреди операции он не может', () => {
    const body = bodyOf(MSG, '  async ownerProfileId(): Promise<number> {');
    expect(body).toContain('if (this.ownerPid !== null) return this.ownerPid;');
    expect(body).toContain('this.ownerPid = found;');
  });

  test('поиск идёт через общее правило', () => {
    expect(bodyOf(MSG, '  private lookupOwnerPid(): number | null {')).toContain('ownerPidByDid(');
  });

  test('глобальный «активный профиль» в переписке больше не спрашивают', () => {
    // Единственное упоминание — внутри lookupOwnerPid, где оно и есть правило.
    expect(MSG.split('profileManager.getActiveProfile()').length - 1).toBe(1);
    expect(MSG).not.toContain('activeProfileId');
    expect(MSG).not.toContain("getActiveProfile()?.id ?? 1");
  });
});

describe('проверка не пустая', () => {
  /** Как было до 457-го: номер профиля читался глобально, на каждом вызове. */
  const BEFORE = `    const active = profileManager.getActiveProfile();
    if (active) return active.id;`;

  test('старое чтение активного профиля было бы поймано', () => {
    expect(BEFORE).toContain('return active.id;');
    expect(MSG).not.toContain(BEFORE);
  });

  test('старое правило вернуло бы чужой профиль', () => {
    // Ровно тот сценарий: наш ключ — A, активен уже B.
    const oldRule = (active: ProfileIdentity | null): number => active?.id ?? 1;
    expect(oldRule(B)).toBe(2);
    expect(ownerPidByDid(A.did, B, () => [A, B])).toBe(1);
  });
});
