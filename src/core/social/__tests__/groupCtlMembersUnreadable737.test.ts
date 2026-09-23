/**
 * v4.32.737: нечитаемый состав перестал выдаваться за разосланное всем.
 *
 * Дефект. `fanoutGroupControl` брал состав через `listGroupMembers`, а тот на
 * сбое чтения отдаёт пустой список. Пустой список адресатов в группе — случай
 * законный (группа, где кроме меня никого), и воронка честно считает рассылку
 * по нему состоявшейся: `{ sent: true, recipients: 0 }`. Два разных случая
 * сходились в один ответ, и «состав не прочитался» становилось «все
 * оповещены».
 *
 * Хуже всего это на выходе из группы. Модалка обещает дословно «Участники
 * увидят, что вы вышли», следом строка группы удаляется, а повтора у
 * служебного конверта нет вовсе — сказать было уже нечем и некому. Для
 * остальных человек остаётся в списке навсегда. Ровно те фразы, которые для
 * этого и написаны (groupControlOutcome), были при этом недостижимы: `sent`
 * не бывал false.
 *
 * То же чтение и тем же поводом рассылка СООБЩЕНИЯ получила ещё в v4.32.648,
 * а своё слово — в v4.32.700. Управляющий конверт остался с прежним.
 */

import fs from 'fs';
import path from 'path';

import { fanoutReasonText, undeliveredText } from '../controlFanout';
import { groupControlProblem } from '../groupControlOutcome';

// controlFanout тянет службу отправки, а та — `uuid`, который приходит как ESM
// и не проходит трансформацию jest. Здесь проверяются слова, а не отправка.
jest.mock('../messaging', () => ({ getMessagingService: () => null }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** Только код: комментарии не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const GRP = codeOnly(read('groupMessaging.ts'));

describe('состав, который не прочитался, — отдельный ответ', () => {
  const FANOUT = (() => {
    const a = GRP.indexOf('export async function fanoutGroupControl(');
    expect(a).toBeGreaterThan(-1);
    const b = GRP.indexOf('export async function sendGroupControlTo(', a);
    expect(b).toBeGreaterThan(a);
    return GRP.slice(a, b);
  })();

  it('состав берётся различающим чтением', () => {
    expect(FANOUT).toContain('const members = await listGroupMembersRead(groupId, ownerProfileId);');
    // Прежняя форма — та, на которой сбой чтения был неотличим от пустой группы.
    expect(FANOUT).not.toContain('const members = await listGroupMembers(groupId, ownerProfileId);');
  });

  it('на отказ чтения рассылка не объявляется состоявшейся', () => {
    const guard = FANOUT.indexOf('if (!members) {');
    expect(guard).toBeGreaterThan(-1);
    const tail = FANOUT.slice(guard);
    expect(tail).toContain("log.warn('group_ctl_members_unreadable'");
    expect(tail).toContain("return { op: ctl.op, sent: false, reason: 'members_unreadable' };");
    // И отказ стоит ДО отправки: рассылать по непрочитанному списку нельзя.
    expect(guard).toBeLessThan(FANOUT.indexOf('await fanoutControlEnvelope('));
  });
});

describe('человеку называют то, что случилось на самом деле', () => {
  it('причина не выдаётся за обрыв связи', () => {
    // Связь могла быть — не прочитался список адресатов.
    expect(fanoutReasonText('members_unreadable', 'group')).toBe('состав группы не прочитан');
    expect(fanoutReasonText('members_unreadable', 'dm')).toBe('состав группы не прочитан');
  });

  it('выход из группы получает свою фразу о расхождении', () => {
    const text = groupControlProblem({ op: 'leave', sent: false, reason: 'members_unreadable' });
    expect(text).toBe(
      'Вы вышли из группы, но участники об этом не узнали — для них вы остались в списке ' +
        '(состав группы не прочитан).'
    );
  });

  it('то же и у остальных операций — фраза берётся по операции', () => {
    expect(groupControlProblem({ op: 'ban', sent: false, reason: 'members_unreadable' })).toContain(
      'Участник заблокирован только у вас'
    );
    expect(undeliveredText('Голос записан у вас', 'members_unreadable')).toBe(
      'Голос записан у вас, но остальные об этом не узнали: состав группы не прочитан.'
    );
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние причины отвечают по-прежнему', () => {
  it('нет связи и некому — слова не изменились', () => {
    expect(fanoutReasonText('all_failed', 'group')).toBe('нет связи');
    expect(fanoutReasonText('no_peer', 'group')).toBe('некому отправить');
    expect(fanoutReasonText('no_peer', 'dm')).toBe('собеседник не определён');
    expect(groupControlProblem({ op: 'leave', sent: true, recipients: 3 })).toBeNull();
  });
});
