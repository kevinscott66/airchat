/**
 * v4.32.662: удаление отложенного сообщения — только своей строки.
 *
 * `deleteScheduledMessage(id)` без второго довода берёт профиль, активный В
 * МОМЕНТ УДАЛЕНИЯ. В `flushDueOnce` между проверкой профиля в начале витка и
 * удалением лежит вся отправка — сетевой круг на сообщение или рассылка всей
 * группе. Переключил человек профиль за это время — DELETE не находил строки,
 * она доживала до следующего тика и уходила ВТОРОЙ раз (и так до
 * ABANDON_AFTER_MS). В экранах то же самое мягче: список собран под одним
 * профилем, удаление уходило под другим, а человеку рапортовали успех.
 *
 * `scheduledMessages.ts` здесь не импортируется: он тянет `uuid`, а тот
 * приезжает как ESM, который jest в этом проекте не преобразует. Форма его
 * исходника читается с диска — тем же приёмом, что в scheduledDispatch.test.ts.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const FLUSH = () => read('core', 'social', 'scheduledMessages.ts');
const LOCAL = () => read('core', 'storage', 'local.ts');
const CHAT = () => read('ui', 'screens', 'ChatScreen.tsx');
const GROUPS = () => read('ui', 'screens', 'GroupsScreen.tsx');

/** Только код: строки-комментарии убраны, чтобы пояснения не подменяли собой проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('удаление отложенного сообщения адресовано владельцу строки', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: local.ts без второго довода берёт активный профиль', () => {
    const local = LOCAL();
    expect(local).toContain(
      'export async function deleteScheduledMessage(id: string, ownerProfileId?: number): Promise<void> {'
    );
    expect(local).toContain(
      "const pid = ownerProfileId ?? (await import('../identity/profileManager')).profileManager.getActiveProfile()?.id ?? 1;"
    );
    expect(local).toContain(
      "'DELETE FROM scheduled_messages WHERE id = ? AND owner_profile_id = ?'"
    );
  });

  it('все шесть удалений в flushDueOnce передают pid', () => {
    const flush = FLUSH();
    // v4.32.714: шестое — снятие строки, отправку которой отклонили.
    expect(countOf(flush, 'deleteScheduledMessage(msg.id, pid)')).toBe(6);
    expect(codeOnly(flush)).not.toContain('deleteScheduledMessage(msg.id)');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: между сторожем профиля и удалением лежит отправка', () => {
    const flush = FLUSH();
    const guard = flush.indexOf("log.info('scheduled_flush_profile_switched_abort', { pid });");
    const send = flush.indexOf('await svc.sendMessage(msg.contactPubB64, msg.text, mediaUris);');
    const del = flush.indexOf('await deleteScheduledMessage(msg.id, pid);', send);
    expect(guard).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(guard);
    expect(del).toBeGreaterThan(send);
    // Строки выбраны под тем же pid — значит он и есть владелец.
    expect(flush).toContain('const due = await listDueScheduledMessages(pid);');
  });

  it('экраны удаляют под тем же профилем, под которым собрали список', () => {
    const groups = GROUPS();
    expect(groups).toContain('await listGroupScheduledMessages(group.id, pid);');
    expect(groups).toContain('await deleteScheduledMessage(id, pid);');

    const chat = CHAT();
    expect(chat).toContain('await listAllScheduledMessages(activeProfileId);');
    expect(chat).toContain('await deleteScheduledMessage(id, activeProfileId);');

    expect(codeOnly(groups)).not.toContain('deleteScheduledMessage(id)');
    expect(codeOnly(chat)).not.toContain('deleteScheduledMessage(id)');
  });
});
