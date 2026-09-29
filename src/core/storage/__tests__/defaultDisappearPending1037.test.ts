/**
 * Непрочитанное умолчание не выдаётся за «выключено» (v4.32.1037).
 *
 * ДЕФЕКТ. `prepareConvTouch` брал автоудаление по умолчанию короткой формой
 * `getDefaultDisappearMsFor`, которая сводит «настройка выключена» и «базу
 * прочитать не смогли» к одному `null`. Само же правило одноразовое: оно
 * применяется на первом сообщении разговора, после чего `last_message_at`
 * остаётся непустым навсегда и второй попытки не будет.
 *
 * ЦЕНА. Одна занятая SQLite в момент первого сообщения — и разговор до конца
 * жизни без таймера, хотя человек включил «Автоудаление новых чатов».
 * Отличить его не по чему: у чата без автоудаления плашки «Исчезают через …»
 * и не бывает, в карточке написано «Автоудаление: Выкл» — ровно то же, что у
 * любого обычного чата. Человек пишет в него как в исчезающий, и написанное
 * остаётся на диске и уезжает в облачную копию. Провал чтения в кэш не
 * кладётся, поэтому соседние разговоры заводятся правильно: у человека часть
 * чатов с таймером, часть без, без единого признака почему.
 *
 * ПРАВКА. Чтение стало исходом; провал окно не закрывает — разговор
 * помечается должником, и первое же удачное чтение доделывает начатое.
 *
 * ГРАНИЦЫ. Список долгов живёт в памяти процесса намеренно: писать о нём в
 * ту самую базу, которая только что не ответила, смысла нет. Перезапуск до
 * следующего сообщения отсрочку теряет — остаток дыры, названный здесь
 * прямо. Долг принадлежит паре «профиль + собеседник» и уходит вместе с
 * удалённым профилем.
 */
import fs from 'fs';
import path from 'path';

const mockKv: Record<string, string> = {};
let mockReadFails = false;

jest.mock('../local', () => ({
  kvTryGet: jest.fn(async (k: string) => (mockReadFails ? null : { value: mockKv[k] ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv[k] = v; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv[k] = v; return true; }),
  kvDelete: jest.fn(async (k: string) => { delete mockKv[k]; }),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));

import {
  clearDefaultDisappearPending,
  forgetDefaultDisappear,
  isDefaultDisappearPending,
  markDefaultDisappearPending,
} from '../defaultDisappear';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const ALICE = 'QWxpY2U=';
const BOB = 'Qm9i';

beforeEach(() => {
  mockReadFails = false;
  for (const p of [1, 2, 7]) forgetDefaultDisappear(p);
});

describe('долг по умолчанию', () => {
  it('без отметки долга нет', () => {
    expect(isDefaultDisappearPending(1, ALICE)).toBe(false);
  });

  it('отметка ставится и снимается', () => {
    markDefaultDisappearPending(1, ALICE);
    expect(isDefaultDisappearPending(1, ALICE)).toBe(true);
    clearDefaultDisappearPending(1, ALICE);
    expect(isDefaultDisappearPending(1, ALICE)).toBe(false);
  });

  it('долг принадлежит одному разговору, а не всем сразу', () => {
    markDefaultDisappearPending(1, ALICE);
    expect(isDefaultDisappearPending(1, BOB)).toBe(false);
    // Иначе первое же удачное чтение поставило бы таймер чужой переписке,
    // которая своё окно закрыла честно.
    expect(isDefaultDisappearPending(2, ALICE)).toBe(false);
  });

  it('соседний профиль чужой долг не наследует', () => {
    markDefaultDisappearPending(1, ALICE);
    markDefaultDisappearPending(2, ALICE);
    clearDefaultDisappearPending(1, ALICE);
    expect(isDefaultDisappearPending(2, ALICE)).toBe(true);
  });

  it('уборка профиля уносит и его долги', () => {
    markDefaultDisappearPending(7, ALICE);
    markDefaultDisappearPending(7, BOB);
    markDefaultDisappearPending(2, ALICE);
    forgetDefaultDisappear(7);
    // Номер достаётся следующему профилю: долг пережил бы удаление аккаунта
    // и поставил таймер разговору, которого прежний хозяин не заводил.
    expect(isDefaultDisappearPending(7, ALICE)).toBe(false);
    expect(isDefaultDisappearPending(7, BOB)).toBe(false);
    expect(isDefaultDisappearPending(2, ALICE)).toBe(true);
  });
});

describe('форма исходников', () => {
  it('след разговора читает настройку исходом, а не числом', () => {
    const s = read('core/storage/local.ts');
    expect(s).toContain('const read = await getDefaultDisappearMsReadFor(t.ownerProfileId);');
    expect(s).toContain('defaultUnknown: read === null,');
    // Короткая форма в этом месте и была дефектом.
    expect(s).not.toContain('await getDefaultDisappearMsFor(t.ownerProfileId)');
  });

  it('решение спрашивает про долг и сам долг ведёт', () => {
    const s = read('core/storage/local.ts');
    expect(s).toContain('pendingDefault: isDefaultDisappearPending(ownerProfileId, contactPubB64),');
    expect(s).toContain('markDefaultDisappearPending(ownerProfileId, contactPubB64);');
    expect(s).toContain('clearDefaultDisappearPending(ownerProfileId, contactPubB64);');
  });

  it('долг закрывается и удачным чтением, и выбором человека', () => {
    // Иначе список рос бы без конца, а отложенное умолчание однажды
    // перекрыло бы снятый вручную таймер.
    expect(read('core/storage/local.ts')).toContain(
      "if (existing?.disappear_after_ms != null || !defaultUnknown) {",
    );
  });

  it('список долгов на диск не пишется', () => {
    const s = read('core/storage/defaultDisappear.ts');
    expect(s).toContain('const pendingKeys = new Set<string>();');
    // Ни одной записи в kv рядом с долгом: база в этот момент и не ответила.
    expect(s.split('scopedKvSetCheckedFor').length - 1).toBe(2);
  });
});
