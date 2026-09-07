/**
 * Адрес файла из чужого сообщения больше не стирает файл (v4.32.628).
 *
 * Голосовое несёт в тексте `\x01voice:{"uri":"file://…"}` — единственное место
 * в базе, где путь к файлу приходит строкой сообщения. Собеседник мог прислать
 * конверт с путём к чужому файлу в кэше получателя и удалить сообщение: уборка
 * подбирала адрес из удаляемой строки и стирала названный файл. Имя
 * расшифрованного вложения (`airchat_media_<id>~<отпечаток>.<ext>`) считается,
 * а не хранится, поэтому список живых ссылок его не защищал.
 *
 * Проверяется форма исходника: local.ts требует живого SQLite. Плюс живая
 * проверка того, ради чего всё затевалось, — что voiceFileUrisIn действительно
 * вынимает из чужого текста путь к файлу вложения.
 */
import fs from 'fs';
import path from 'path';
import { voiceFileUrisIn, blobCacheName } from '../../media/blobRef';

/** Исходник без строк-комментариев: в них старая форма упомянута нарочно. */
const SRC = fs
  .readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n');

/** Текст аргументов каждого вызова collectAttachmentRefs. */
function calls(): string[] {
  return SRC.split('await collectAttachmentRefs(')
    .slice(1)
    .map((part) => {
      const end = part.indexOf(');');
      expect(end).toBeGreaterThan(0);
      return part.slice(0, end);
    });
}

it('вызовов ровно десять: один за живыми ссылками, девять за обречёнными', () => {
  const c = calls();
  expect(c).toHaveLength(10);
  expect(c.filter((a) => /'any'\s*$/.test(a.trim()))).toHaveLength(1);
  expect(c.filter((a) => /'own'\s*,?\s*$/.test(a.trim()))).toHaveLength(9);
});

it('единственный доверчивый вызов — тот, что файлы сохраняет', () => {
  const trusting = calls().filter((a) => a.includes("'any'"));
  expect(trusting).toHaveLength(1);
  expect(trusting[0]).toContain('alive');
  expect(trusting[0]).not.toContain('doomed');
});

it('обречённые строки личной переписки помечают своё авторство', () => {
  const doomedChat = calls().filter((a) => a.includes('FROM chat_messages WHERE'));
  expect(doomedChat.length).toBeGreaterThanOrEqual(4);
  for (const a of doomedChat) {
    expect(a).toContain("direction = 'out' AS mine");
    expect(a).toContain("'own'");
  }
});

it('обречённые строки групп не признают своими ни одну', () => {
  const doomedGroup = calls().filter((a) => a.includes('FROM group_messages WHERE'));
  expect(doomedGroup.length).toBeGreaterThanOrEqual(5);
  for (const a of doomedGroup) {
    expect(a).toContain('0 AS mine');
    expect(a).toContain("'own'");
  }
});

it('ни один обречённый запрос не остался без колонки авторства', () => {
  expect(SRC).not.toMatch(/SELECT text, media_cids FROM (?:chat|group)_messages WHERE/);
});

it('список живых ссылок остался прежним — он только сохраняет файлы', () => {
  expect(SRC).toContain("'SELECT text, media_cids FROM chat_messages',");
  expect(SRC).toContain("'SELECT text, media_cids FROM group_messages',");
  expect(SRC).toContain("'SELECT payload AS text, NULL AS media_cids FROM outbox',");
});

it('само правило: без mine = 1 адрес из текста не берётся', () => {
  expect(SRC).toContain("if (voiceUris === 'any' || r.mine === 1) {");
  // Решение обязано быть у каждого вызова: значения по умолчанию нет.
  expect(SRC).toContain('  voiceUris: VoiceUriTrust\n');
  expect(SRC).not.toContain('voiceUris: VoiceUriTrust =');
  expect(SRC).toContain("type VoiceUriTrust = 'any' | 'own';");
});

it('ПРОВЕРКА НЕ ПУСТАЯ: чужой текст правда отдаёт путь к файлу вложения', () => {
  const name = blobCacheName({ u: 'https://r/x', k: 'a'.repeat(43) }, 'jpg');
  expect(name).toMatch(/^airchat_media_.+~.+\.jpg$/);
  const uri = `file:///data/user/0/tech.dobropalm.airchat/cache/${name}`;
  const crafted = `\x01voice:{"uri":"${uri}","durationMs":1000}`;
  expect(voiceFileUrisIn(crafted)).toEqual([uri]);
  // И сам исходник на месте: пустая строка эти проверки бы прошла молча.
  expect(SRC.length).toBeGreaterThan(200000);
  expect(SRC).toContain('async function dropOrphanBlobCache(');
  expect(SRC).toContain('for (const uri of voiceFileUrisIn(text)) into.uris.add(uri);');
});
