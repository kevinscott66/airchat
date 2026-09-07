/**
 * Надгробие группы, приехавшее синхронизацией, убирает за собой (v4.32.623).
 *
 * `deleteSyncEntity` сносила одну строку `groups`, оставляя сообщения группы,
 * её состав, артефакты опросов и расшифрованные вложения в кэше. Место —
 * полбеды: id группы постоянный, и при повторном приглашении в ту же группу
 * оживал старый состав вместе с ролями тех, кого из неё убрали.
 *
 * Здесь проверяется форма исходника, а не поведение: `local.ts` требует живого
 * SQLite, а разница между «удалить строку» и «позвать deleteGroup» видна прямо
 * в ветке. Ниже — соседние ветки того же switch как положительный контроль:
 * они по-прежнему удаляют строку сами, и вырезка не пустая.
 */
import fs from 'fs';
import path from 'path';

const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

/** Тело switch внутри deleteSyncEntity. */
function branch(kind: string): string {
  const fn = LOCAL.indexOf('export async function deleteSyncEntity(');
  expect(fn).toBeGreaterThan(0);
  const from = LOCAL.indexOf(`case '${kind}':`, fn);
  expect(from).toBeGreaterThan(fn);
  const to = LOCAL.indexOf("    case '", from + 10);
  expect(to).toBeGreaterThan(from);
  return LOCAL.slice(from, to);
}

it('ветка группы делегирует полную уборку, а не удаляет одну строку', () => {
  const group = branch('group');
  expect(group).toContain('await deleteGroup(entityId, ownerProfileId);');
  expect(group).not.toContain('DELETE FROM groups');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: у одиночных сущностей вырезка та же и она со строкой', () => {
  expect(branch('message')).toContain('DELETE FROM chat_messages');
  expect(branch('group_message')).toContain('DELETE FROM group_messages');
});

it('deleteGroup действительно снимает всё, что перечислено', () => {
  const from = LOCAL.indexOf('export async function deleteGroup(');
  expect(from).toBeGreaterThan(0);
  const body = LOCAL.slice(from, LOCAL.indexOf('\nexport ', from + 10));
  expect(body).toContain('DELETE FROM groups');
  expect(body).toContain('DELETE FROM group_members');
  expect(body).toContain('DELETE FROM group_messages');
  expect(body).toContain('deletePollArtifactsBySelect');
  expect(body).toContain('dropOrphanBlobCache');
  // v4.32.623: заявки на вступление. Их не снимало ничто, кроме сноса профиля
  // целиком: updateGroupJoinRequestStatus только переставляет флаг. В заявке
  // лежат имя просившегося и его сообщение — и оставались они у бывшего
  // администратора вечно, у группы, которой больше нет.
  expect(body).toContain('DELETE FROM group_join_requests');
});

it('заявки снимаются внутри той же транзакции, что и остальные строки', () => {
  const from = LOCAL.indexOf('export async function deleteGroup(');
  const body = LOCAL.slice(from, LOCAL.indexOf('\nexport ', from + 10));
  const tx = body.indexOf("'delete_group',");
  const files = body.indexOf('() => dropOrphanBlobCache(doomed)');
  const del = body.indexOf('DELETE FROM group_join_requests');
  expect(tx).toBeGreaterThan(0);
  expect(del).toBeGreaterThan(tx);
  // Уборка файлов идёт после фиксации — строки должны лечь до неё.
  expect(del).toBeLessThan(files);
});

it('ПРОВЕРКА НЕ ПУСТАЯ: флаг заявки по-прежнему только переставляется', () => {
  expect(LOCAL).toContain('UPDATE group_join_requests SET status = ? WHERE id = ? AND status = ?');
});
