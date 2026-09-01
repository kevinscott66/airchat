/**
 * Запись системной строки в свою группу.
 *
 * v4.32.258. Один и тот же литерал вставки был выписан девятнадцать раз —
 * `insertGroupMessage({ id: uuidv4(), groupId: group.id, senderPubB64:
 * myPubB64, senderName: null, text: makeGroupSysText(…), mediaCids: null,
 * replyToId: null, replyToPreview: null, reactions: null, createdAt:
 * Date.now(), ownerProfileId: pid })` — и отличался в них только текстом
 * события. Восемь полей из десяти в каждой копии несут одно и то же значение,
 * и любое из них можно однажды набрать иначе: senderName вместо null, чужой
 * ownerProfileId, забытый префикс. Тогда строка перестанет быть системной —
 * останется обычным сообщением от своего имени.
 *
 * Отдельно от groupSysLine, потому что здесь уже есть побочные эффекты (БД и
 * uuid): разбор префикса остаётся чистым и тестируется без SQLite.
 */
import { v4 as uuidv4 } from 'uuid';
import { insertGroupMessage } from '../../core/storage/local';
import { makeGroupSysText } from '../../core/social/groupSysLine';

/**
 * @param event — текст события без префикса («Группа переименована в «X»»).
 * @param createdAt — время строки; по умолчанию сейчас. Явное значение нужно
 *   только тем строкам, что обязаны встать раньше уже вставленного сообщения
 *   (например, «создал(а) группу» перед первым приветствием).
 */
export async function insertGroupSysMessage(
  groupId: string,
  pid: number,
  senderPubB64: string,
  event: string,
  createdAt: number = Date.now()
): Promise<void> {
  await insertGroupMessage({
    id: uuidv4(),
    groupId,
    senderPubB64,
    senderName: null,
    text: makeGroupSysText(event),
    mediaCids: null,
    replyToId: null,
    replyToPreview: null,
    reactions: null,
    createdAt,
    ownerProfileId: pid,
  });
}
