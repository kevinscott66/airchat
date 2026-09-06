/**
 * Храповик на сборку ссылок.
 *
 * v4.32.606. До этой версии ссылку собирали пять мест, и каждое по-своему:
 * `airchat://dm/…/msg/…` в переписке, `airchat://group/…/msg/…` в группах
 * дважды, голый DID в профиле и в карточке собеседника, а у публикации ссылки
 * не было вовсе. Три из них были мертвы: обработчик deep link знал только
 * `join-group` и `tab`, остальное молча не открывалось.
 *
 * Отсюда правило: адрес ссылки живёт в одном файле — `core/net/appLink`, — и
 * потому его можно сменить одной строкой, не потеряв уже разосланные ссылки
 * (разбор смотрит на форму пути, а не на хост). Правило держится, только пока
 * схему `airchat://` никто не пишет строкой у себя: такая строка соберётся под
 * прежним адресом и не сменится вместе со всеми.
 *
 * Исключение ровно одно — `core/social/groupInviteLink`. Приглашение несёт
 * свою полезную нагрузку и свой разбор, его префикс — часть формата ссылки, а
 * не адрес; наружу оно уходит через `webForm` (см. GroupsScreen).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..');

/**
 * Файлы, которым позволено писать схему приложения строкой.
 *
 * `contacts.ts` — не сборщик: он снимает схему с того, что человек ВСТАВИЛ в
 * поле «Новый контакт», включая формы прежних версий (`airchat://did:key:…`),
 * которых сегодняшний сборщик уже не выдаёт. Прочитать старое приложение
 * обязано, иначе у людей перестанут работать уже разосланные строки.
 */
const ALLOWED = new Set([
  'core/net/appLink.ts',
  'core/social/groupInviteLink.ts',
  'core/social/contacts.ts',
]);

/** Экраны, которые отдают ссылку наружу: копирование, «Поделиться», QR. */
const OUTWARD = [
  'ui/screens/ChatScreen.tsx',
  'ui/screens/GroupsScreen.tsx',
  'ui/screens/FeedScreen.tsx',
  'ui/screens/ProfileScreen.tsx',
  'ui/components/UserProfilePeek.tsx',
];

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      collect(full, out);
      continue;
    }
    if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Строки без комментариев: схема, названная в объяснении, — не сборка. */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*') || line.startsWith('{/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

function relKey(full: string): string {
  return full.slice(SRC.length + 1).split('\\').join('/');
}

describe('ссылку собирает один файл', () => {
  const files = collect(SRC).map((f) => ({ key: relKey(f), lines: codeLines(readFileSync(f, 'utf8')) }));

  it('схема airchat:// не пишется строкой нигде, кроме сборщиков', () => {
    const offenders = files
      .filter((f) => !ALLOWED.has(f.key))
      .filter((f) => f.lines.some((l) => l.includes('airchat://')))
      .map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('адрес сайта не пишется строкой нигде, кроме сборщика', () => {
    // Сменить адрес — значит поправить DEFAULT_LINK_BASE. Вторая копия строки
    // осталась бы на прежнем домене молча.
    const offenders = files
      .filter((f) => f.key !== 'core/net/appLink.ts')
      .filter((f) => f.lines.some((l) => l.includes('air.dobropalm.tech')))
      .map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('каждый экран, отдающий ссылку наружу, зовёт общий сборщик', () => {
    const missing = OUTWARD.filter((key) => {
      const f = files.find((x) => x.key === key);
      if (!f) return true;
      return !f.lines.some((l) => l.includes("core/net/appLink'"));
    });
    expect(missing).toEqual([]);
  });
});
