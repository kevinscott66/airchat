/**
 * linkPlatform — адреса и имена учётных записей на внешних площадках
 * (v4.32.575).
 *
 * Выделено из linkProof, где эти правила и жили. Причина не в размере файла:
 * linkProof проверяет подписи, а значит тянет за собой криптографию, и всё,
 * что его импортирует, тянет её тоже. Имя учётной записи и адрес публикации
 * между тем нужны и там, где криптографии быть не должно, — разбору конверта
 * профиля (social/profileEnvelope), который намеренно держат чистым: он
 * читает недоверенный ввод, и его проверки покрыты тестами без транспорта,
 * базы и нативных модулей.
 *
 * Правило здесь одно на всех. Второй набор регулярных выражений рядом — это
 * не дублирование ради удобства, а расхождение, которое обязательно случится:
 * одно место починят, другое нет, и адрес, который не прошёл проверку при
 * вводе, проедет в конверте.
 *
 * Модуль без импортов вовсе.
 */

/** Площадки, для которых у публикации есть проверяемый автор. */
export type LinkPlatform = 'github' | 'x';

export const PLATFORM_LABEL: Record<LinkPlatform, string> = { github: 'GitHub', x: 'X' };

/**
 * Правила имён — те же, что у самих площадок.
 *
 * GitHub: буквы, цифры и дефис, не по краям, до 39 символов.
 * X: буквы, цифры и подчёркивание, до 15.
 *
 * Правило нужно не для красоты ввода. Имя подставляется в адрес
 * `https://github.com/<h>`, и `foo/../../evil` в этом месте — открытый
 * редирект; такую же проверку уже держит показ ссылок в профиле.
 */
const HANDLE_RE: Record<LinkPlatform, RegExp> = {
  github: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
  x: /^[A-Za-z0-9_]{1,15}$/,
};

/** Хосты, из адреса на которые можно вынуть имя. */
const HANDLE_HOSTS: Record<LinkPlatform, string[]> = {
  github: ['github.com', 'gist.github.com'],
  x: ['x.com', 'twitter.com', 'mobile.twitter.com'],
};

/**
 * Имя учётной записи из того, что человек вставил.
 *
 * Принимается и `@octocat`, и `octocat`, и целый адрес профиля: люди копируют
 * адресную строку, и требовать от них выкусить оттуда имя — значит получать
 * `https://github.com/octocat` в поле имени и молча показывать ссылку на
 * `github.com/https://github.com/octocat`.
 *
 * Регистр сохраняется: он часть того, как человек себя пишет. Сверяются имена
 * без учёта регистра — на обеих площадках `Octocat` и `octocat` это одна
 * учётная запись (см. sameHandle).
 */
export function normalizeHandle(platform: LinkPlatform, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // Адрес профиля: берём первый сегмент пути и только у знакомых хостов.
  const m = /^(?:https?:\/\/)?(?:www\.)?([A-Za-z0-9.-]+)\/([^/?#]+)/.exec(s);
  if (m) {
    const host = m[1].toLowerCase();
    if (!HANDLE_HOSTS[platform].includes(host)) return null;
    s = m[2];
  }
  s = s.replace(/^@/, '').trim();
  return HANDLE_RE[platform].test(s) ? s : null;
}

/** Одна ли это учётная запись. Обе площадки регистр не различают. */
export function sameHandle(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Адрес профиля — собирается здесь, чтобы имя не склеивали руками в разметке. */
export function profileUrl(platform: LinkPlatform, handle: string): string | null {
  const h = normalizeHandle(platform, handle);
  if (!h) return null;
  return platform === 'github' ? `https://github.com/${h}` : `https://x.com/${h}`;
}

/** Идентификатор gist из адреса, который человек вставил. */
export function parseGistId(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = /^(?:https?:\/\/)?gist\.github\.com\/(?:[A-Za-z0-9-]{1,39}\/)?([0-9a-f]{20,32})(?:[/?#]|$)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Адрес записи X — вместе с именем автора, каким его показывает сама ссылка. */
export function parseTweetUrl(url: unknown): { handle: string; id: string } | null {
  if (typeof url !== 'string') return null;
  const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:[/?#]|$)/i
    .exec(url.trim());
  return m ? { handle: m[1], id: m[2] } : null;
}

/**
 * Адрес публикации в каноническом виде — или null, если это не он.
 *
 * Нужен там, где адрес приезжает из чужого конверта: показать и открыть можно
 * только то, что разобрано по этим же правилам. Хранить «как прислали» нельзя
 * — тогда в профиле собеседника оказалась бы произвольная ссылка, которую
 * приложение предлагает открыть.
 */
export function normalizeProofUrl(platform: LinkPlatform, url: unknown): string | null {
  if (platform === 'github') {
    const id = parseGistId(url);
    return id ? `https://gist.github.com/${id}` : null;
  }
  const t = parseTweetUrl(url);
  return t ? `https://x.com/${t.handle}/status/${t.id}` : null;
}
