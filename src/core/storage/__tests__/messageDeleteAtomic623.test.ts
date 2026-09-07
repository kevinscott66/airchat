/**
 * Удаление одного сообщения уносит и следы опроса — или ничего (v4.32.623).
 *
 * `deleteChatMessage` и `deleteGroupMessage` сносили строку, а варианты ответа
 * и голоса убирали следующей, отдельной записью. Разрыв между ними оставлял в
 * базе артефакты опроса, привязанные к id, которого больше не существует, —
 * навсегда: подобрать их было некому. Соседний `clearGroupMessages` в том же
 * файле пишет обе операции одной транзакцией с самого начала.
 *
 * Проверяется форма исходника: `local.ts` требует живого SQLite, а уронить его
 * ровно между двумя записями в тесте нечем. Положительный контроль —
 * `clearGroupMessages`, чью форму эта правка не трогала.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

function body(name: string): string {
  const from = SRC.indexOf(`export async function ${name}(`);
  expect(from).toBeGreaterThan(0);
  const to = SRC.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to);
}

it('групповое сообщение: строка и следы опроса внутри одной транзакции', () => {
  const b = body('deleteGroupMessage');
  const tx = b.indexOf("'delete_group_message',");
  expect(tx).toBeGreaterThan(0);
  expect(b.indexOf('await deletePollArtifacts(d, [messageId], ownerProfileId);')).toBeGreaterThan(tx);
  expect(b.indexOf("'DELETE FROM group_messages WHERE id = ? AND owner_profile_id = ?'")).toBeGreaterThan(tx);
  // Файлы — после фиксации, вторым обработчиком eraseAtomically.
  expect(b).toContain('() => dropOrphanBlobCache(doomed)');
});

it('личное сообщение: то же, и «строки не было» по-прежнему возвращает false', () => {
  const b = body('deleteChatMessage');
  const tx = b.indexOf("'delete_chat_message',");
  expect(tx).toBeGreaterThan(0);
  expect(b.indexOf("'DELETE FROM chat_messages WHERE id = ? AND owner_profile_id = ?'")).toBeGreaterThan(tx);
  expect(b.indexOf('await deletePollArtifacts(d, [id], ownerProfileId);')).toBeGreaterThan(tx);
  // Отказ «нечего удалять» не потерялся при переносе внутрь транзакции.
  expect(b).toContain('if (!anyChanged(res)) return;');
  expect(b).toContain("log.warn('chat_message_delete_no_row'");
  expect(b).toContain('if (!removed) {');
  // Кэш вложений сносим только если строка правда ушла.
  expect(b).toContain('if (removed) await dropOrphanBlobCache(doomed);');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: соседняя очистка истории группы осталась как была', () => {
  const b = body('clearGroupMessages');
  expect(b).toContain("'clear_group_messages',");
  expect(b).toContain('() => dropOrphanBlobCache(doomed)');
});
