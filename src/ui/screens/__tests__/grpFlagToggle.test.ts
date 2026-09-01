/**
 * v4.32.531: четыре переключателя настроек группы и операции над строкой
 * списка объявляли успех, не дождавшись ответа базы.
 *
 * Тест держит две вещи. Слова переключателя — чистой проверкой (подпись
 * называет действие, у «Закреплять могут все» она перевёрнута относительно
 * флага, патч всегда ровно об одном поле). И форму экрана — тем, что в
 * GroupsScreen больше нет ни одного `void <запись в базу>(...)` без
 * перехвата: именно эта форма и была дефектом.
 */
import fs from 'fs';
import path from 'path';
import {
  groupFlagCopy,
  groupFlagNext,
  groupFlagPatch,
  type GroupFlagKey,
} from '../groups-utils/groupFlagToggle';

const KEYS: GroupFlagKey[] = [
  'adminOnlyPosting',
  'adminOnlyPinning',
  'requireApproval',
  'anonymousPosting',
];

const MODULE_SRC = fs.readFileSync(
  path.join(__dirname, '../groups-utils/groupFlagToggle.ts'),
  'utf8'
);
const SCREEN = fs.readFileSync(path.join(__dirname, '../GroupsScreen.tsx'), 'utf8');
// v4.32.546: перехватчик уехал из экрана в общий модуль — те же действия в
// переписке оставались без него.
const GUARD = fs.readFileSync(
  path.join(__dirname, '../../components/runGuardedOp.ts'),
  'utf8',
);

/** Текст аргументов вызова: от открывающей скобки до парной закрывающей. */
function callArgs(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(openParen, i + 1);
    }
  }
  return '';
}

describe('groupFlagToggle — чистая часть', () => {
  it('модуль ничего не импортирует', () => {
    expect(MODULE_SRC).not.toMatch(/^import\s/m);
  });

  it('нажатие переводит флаг в противоположное значение', () => {
    expect(groupFlagNext(true)).toBe(false);
    expect(groupFlagNext(false)).toBe(true);
  });

  it('патч содержит ровно одно поле — то, которое переключили', () => {
    for (const key of KEYS) {
      for (const next of [true, false]) {
        const patch = groupFlagPatch(key, next);
        expect(Object.keys(patch)).toEqual([key]);
        expect(Object.values(patch)).toEqual([next]);
      }
    }
  });

  it('патчи разных флагов не пересекаются полями', () => {
    const seen = KEYS.map((k) => Object.keys(groupFlagPatch(k, true))[0]);
    expect(new Set(seen).size).toBe(KEYS.length);
  });

  it('каждый ключ даёт все четыре текста и ни одного пустого', () => {
    for (const key of KEYS) {
      for (const current of [true, false]) {
        const copy = groupFlagCopy(key, current);
        expect(copy.menu.length).toBeGreaterThan(0);
        expect(copy.success.length).toBeGreaterThan(0);
        expect(copy.sys.length).toBeGreaterThan(0);
        expect(copy.failure.length).toBeGreaterThan(0);
      }
    }
  });

  it('подпись меню меняется вместе с состоянием', () => {
    for (const key of KEYS) {
      expect(groupFlagCopy(key, true).menu).not.toBe(groupFlagCopy(key, false).menu);
    }
  });

  it('«режим только для админов»: подпись называет действие', () => {
    expect(groupFlagCopy('adminOnlyPosting', true).menu).toContain('выкл');
    expect(groupFlagCopy('adminOnlyPosting', false).menu).toContain('вкл');
  });

  it('«закреплять могут все»: подпись перевёрнута относительно флага', () => {
    // Флаг называется adminOnlyPinning, а подпись — про обратное состояние.
    expect(groupFlagCopy('adminOnlyPinning', true).menu).toContain('вкл');
    expect(groupFlagCopy('adminOnlyPinning', false).menu).toContain('выкл');
  });

  it('тост и системная строка описывают будущее состояние', () => {
    expect(groupFlagCopy('adminOnlyPosting', false).success).toBe(
      'Теперь писать могут только администраторы'
    );
    expect(groupFlagCopy('adminOnlyPosting', true).success).toBe('Писать могут все');
    expect(groupFlagCopy('requireApproval', false).sys).toContain('требует одобрения');
    expect(groupFlagCopy('requireApproval', true).sys).toContain('без одобрения');
  });

  it('у каждого флага свой текст отказа', () => {
    const failures = KEYS.map((k) => groupFlagCopy(k, false).failure);
    expect(new Set(failures).size).toBe(KEYS.length);
    for (const f of failures) expect(f.startsWith('Не удалось')).toBe(true);
  });

  it('состояние не участвует в выборе текста отказа', () => {
    for (const key of KEYS) {
      expect(groupFlagCopy(key, true).failure).toBe(groupFlagCopy(key, false).failure);
    }
  });
});

describe('GroupsScreen — записи в базу больше не остаются без перехвата', () => {
  it('есть общий перехватчик и его вариант для строки списка', () => {
    expect(SCREEN).toContain("import { runGuardedOp } from '../components/runGuardedOp';");
    expect(GUARD).toContain('export function runGuardedOp(');
    expect(SCREEN).toContain('const runRowOp = useCallback((op: () => Promise<unknown>, fallback: string): void => {');
  });

  it('перехватчик доносит отказ до человека, а не только до логов', () => {
    const start = GUARD.indexOf('export function runGuardedOp(');
    expect(start).toBeGreaterThan(-1);
    const body = GUARD.slice(start);
    expect(body).toContain('showError(userErrorText(e, fallback))');
  });

  it('неудачу перечитывания списка не выдают за неудачу операции', () => {
    expect(SCREEN).toContain('groups_reload_after_row_op_failed');
  });

  it('переключатель группы записывает раньше, чем объявляет успех', () => {
    const start = SCREEN.indexOf('const toggleGroupFlag = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const body = SCREEN.slice(start, start + 1400);
    expect(body.indexOf('await updateGroupMeta(')).toBeLessThan(body.indexOf('showSuccess(copy.success)'));
    expect(body.indexOf('await updateGroupMeta(')).toBeLessThan(body.indexOf('apply(next)'));
    expect(body).toContain('showError(userErrorText(e, copy.failure))');
  });

  it('все четыре пункта меню берут подпись из одного места', () => {
    const menuUses = SCREEN.match(/text: groupFlagCopy\(/g) ?? [];
    expect(menuUses).toHaveLength(4);
    const toggles = SCREEN.match(/toggleGroupFlag\('/g) ?? [];
    // четыре пункта меню плюс команда /readonly
    expect(toggles.length).toBeGreaterThanOrEqual(5);
  });

  it('операции со строкой списка не перерисовывают список в хвосте обещания', () => {
    expect(SCREEN).not.toContain('.then(loadGroups)');
  });

  it('ни одна запись в базу не запускается без перехвата', () => {
    for (const shape of [
      'void updateGroupMeta(',
      'void setGroupPinned(',
      'void setGroupMuted(',
      'void setGroupMutedUntil(',
      'void setGroupArchived(',
      'void markGroupRead(',
      'void markGroupUnread(',
      'void markAllGroupsRead(',
      'void clearGroupMessages(',
      'void updateGroupJoinRequestStatus(',
      'void setGroupMessageStarred(',
      'void applySlowMode(',
      'void applyDisappear(',
    ]) {
      expect(SCREEN).not.toContain(shape);
    }
  });

  it('у каждого перехвата есть свой русский текст отказа', () => {
    // v4.32.531: запасной текст уехал на вызов перехватчика, поэтому общий
    // храповик errorTextCallSites его там уже не видит. Проверяем здесь: у
    // каждого вызова обоих перехватчиков последним аргументом стоит русская
    // строка, а не забытый undefined и не английская подпись.
    for (const helper of ['runGuardedOp(', 'runRowOp(']) {
      let from = 0;
      let seen = 0;
      for (;;) {
        const at = SCREEN.indexOf(helper, from);
        if (at === -1) break;
        from = at + helper.length;
        // Объявление самой функции — не вызов.
        const before = SCREEN.slice(Math.max(0, at - 30), at);
        if (before.includes('function ') || before.includes('const ')) continue;
        seen++;
        expect(callArgs(SCREEN, at + helper.length - 1)).toContain("'Не удалось");
      }
      expect(seen).toBeGreaterThanOrEqual(6);
    }
  });

  it('«Статистика» сообщает об отказе, а не молчит', () => {
    const start = SCREEN.indexOf('getGroupStats(group.id, pid)');
    expect(start).toBeGreaterThan(-1);
    const body = SCREEN.slice(start, start + 300);
    expect(body).toContain('.catch(');
  });

  it('заявки на вступление обрабатываются под перехватом', () => {
    expect(SCREEN).toContain("}, 'Не удалось одобрить заявку');");
    expect(SCREEN).toContain("}, 'Не удалось отклонить заявку');");
  });

  it('«История очищена» говорится только после удаления', () => {
    const start = SCREEN.indexOf('await clearGroupMessages(');
    expect(start).toBeGreaterThan(-1);
    const body = SCREEN.slice(start, start + 400);
    expect(body.indexOf("showError(userErrorText(e, 'Не удалось очистить историю'))")).toBeLessThan(
      body.indexOf("showSuccess('История очищена')")
    );
  });
});
