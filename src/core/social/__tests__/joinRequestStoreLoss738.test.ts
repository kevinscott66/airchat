/**
 * v4.32.738: заявка на вступление перестала пропадать в тишине.
 *
 * Дефект. Приём заявки у администратора писал строку `await`-ом, не читая
 * ответа, а весь разбор был обёрнут в `try { … } catch { log.debug(…) }`.
 * Любой отказ базы — занятый файл, недоступный ключ данных, ранний запуск —
 * проглатывался, и наружу уходило «разобрано».
 *
 * Цена ошибки здесь односторонняя. Ответить заявителю нечем: у себя он уже
 * увидел «Запрос на вступление отправлен администратору» и ждёт. Повтора у
 * конверта нет, строка в списке заявок не появлялась ни у кого, и узнать об
 * этом было неоткуда — ни ему, ни администратору. Соседняя дорога той же
 * заявки (управляющий конверт 'join') ответ записи читала с самого начала.
 *
 * Второй разлад того же места: состав группы читался формой, которая на сбое
 * отдаёт пустой список. `ownGroupRole` сползал с него на запасной ответ
 * `groups.is_admin` — ту самую колонку, из-за которой правило и переписывали
 * в v4.32.512: повышенный администратор в ней не отмечен, и заявка
 * отбрасывалась как «не наша группа».
 *
 * Проверка идёт по исходнику: `groupMessaging.ts` тянет службу переписки, а
 * та — `uuid`, который приходит как ESM и не проходит трансформацию jest (тот
 * же довод, что в `contactsUnreadableLoss724.test.ts`). Что координатор
 * действительно удерживает отметку на `'deferred'`, проверено поведением в
 * `transport/internet/__tests__/backlogIntake730.test.ts`.
 */

import fs from 'fs';
import path from 'path';

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
const MSG = codeOnly(read('messaging.ts'));

/** Кусок исходника от объявления до СЛЕДУЮЩЕГО объявления, не дальше. */
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(end, a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

const HANDLER = between(
  GRP,
  'export async function handleIncomingGroupJoinRequest(',
  'export { GROUP_CTL_PREFIX, encodeGroupCtlEnvelope, decodeGroupCtlEnvelope };'
);

describe('приём заявки отвечает словом', () => {
  it('объявление обещает вердикт, а не «да»', () => {
    expect(HANDLER).toContain('): Promise<EnvelopeIntake> {');
    expect(HANDLER).not.toContain('): Promise<boolean> {');
  });

  it('ни один выход не остался «да» без разбора', () => {
    expect(HANDLER).not.toMatch(/\breturn true;/);
    expect(HANDLER).not.toMatch(/\breturn false;/);
  });

  it('отказ по делу конверт не откладывает', () => {
    // Бан, не-контакт, отозванная ссылка, не наша группа — повтором не
    // исправляются: перезапрос вернёт ровно тот же конверт и тот же отказ.
    expect(HANDLER).toContain("if (!grp) return 'consumed';");
    const filtered = HANDLER.indexOf("log.info('group_join_request_filtered'");
    expect(filtered).toBeGreaterThan(-1);
    expect(HANDLER.slice(filtered, filtered + 260)).toContain("return 'consumed';");
  });
});

describe('отказ записи — это «перезапросить», а не «разобрано»', () => {
  it('ответ записи читается', () => {
    expect(HANDLER).toContain(
      'const queued = await insertGroupJoinRequest(env.groupId, env.requesterPubB64, env.requesterName, env.message ?? null, pid);'
    );
    expect(HANDLER).toContain('created: queued.created,');
  });

  it('ловушка отказа базы отвечает «отложено» и пишет в журнал громко', () => {
    const c = HANDLER.indexOf('} catch (e) {');
    expect(c).toBeGreaterThan(-1);
    const tail = HANDLER.slice(c);
    expect(tail).toContain("log.warn('group_join_request_store_failed'");
    expect(tail).toContain("return 'deferred';");
    // Прежняя форма: отказ базы шёл в debug и наружу уходило «разобрано».
    expect(tail).not.toContain("log.debug('group_join_request_parse_failed'");
  });

  it('состав берётся различающим чтением, и его отказ тоже откладывает', () => {
    expect(HANDLER).toContain('const grpMembers = await listGroupMembersRead(env.groupId, pid);');
    expect(HANDLER).not.toContain('const grpMembers = await listGroupMembers(env.groupId, pid);');
    const guard = HANDLER.indexOf('if (!grpMembers) {');
    expect(guard).toBeGreaterThan(-1);
    expect(HANDLER.slice(guard, guard + 220)).toContain("return 'deferred';");
  });
});

describe('вердикт доходит до координатора', () => {
  it('приёмник возвращает ответ обработчика, а не выбрасывает его', () => {
    const BRANCH = between(
      MSG,
      'if (textPayload.text?.startsWith(GROUP_JOIN_REQUEST_PREFIX)) {',
      'GROUP_CTL_PREFIX'
    );
    expect(BRANCH).toContain(
      'return await handleIncomingGroupJoinRequest(textPayload.text, await this.groupRecipient(), peerPubKeyB64);'
    );
    expect(BRANCH).not.toContain('if (inbound) await handleIncomingGroupJoinRequest(');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходник прочитан, отбор заявки на месте, образец жив', () => {
    // Всё здесь — то, чего правка не касалась: проверка обязана проходить и
    // до неё, и после. Иначе «до правки всё красное» не значит ничего.
    expect(HANDLER.length).toBeGreaterThan(2000);
    expect(HANDLER).toContain('if (!grp) return');
    expect(HANDLER).toContain("log.info('group_join_request_filtered'");
    // Соседняя дорога той же заявки — управляющий конверт 'join' — кладёт её
    // тем же вызовом. Правки v4.32.738 она не касалась и касаться не должна.
    // (В v4.32.818 там переставили порядок: ответ записи больше не читают,
    // «первая ли заявка» спрашивают чтением до неё. Сам вызов на месте.)
    expect(GRP).toContain(
      'await insertGroupJoinRequest(env.groupId, senderPubB64, displayNameOrNull(env.targetName), null, pid);'
    );
  });
});
