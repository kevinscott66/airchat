/**
 * linkProofCheck — вторая половина проверки привязки: кто автор публикации
 * (v4.32.573).
 *
 * Подпись доказывает, что запись составил владелец аккаунта AirChat. Она НЕ
 * доказывает, что человек владеет учётной записью на площадке: свою же запись
 * можно опубликовать где угодно и назвать её именем @torvalds. Доказывает это
 * только автор публикации — тот, кого называет сама площадка. Поэтому здесь
 * ровно один вопрос: кто опубликовал то, что лежит по этому адресу.
 *
 * Обе площадки отвечают на него открытыми точками, без ключей и входа:
 *
 *  - GitHub: `api.github.com/gists/<id>` отдаёт `owner.login` и содержимое
 *    файлов. Gist должен быть публичным — приватный по этому адресу не
 *    открывается, и это правильно: доказательство, которого не видно, не
 *    доказательство.
 *  - X: `publish.twitter.com/oembed` отдаёт `author_url` и разметку записи.
 *    Точка публичная, но недокументированно капризная — она отвечает не
 *    всегда, и на это опирается отдельный ответ 'network', а не «не сошлось».
 *    Разница существенная: «мы не смогли проверить» и «проверили, не сходится»
 *    — разные новости, и путать их нельзя.
 *
 * Запрос уходит ТОЛЬКО по прямому нажатию человека и только на тот адрес,
 * который он сам вставил. Само по себе приложение в GitHub и X не ходит: это
 * его собственные публичные учётные записи, но IP-адрес всё равно его.
 *
 * `fetch` передаётся параметром, чтобы проверка разбиралась тестами без сети.
 */
import { log } from '../logger';
import {
  verifyProofInText,
  type ProofCheck,
  type ProofExpectation,
} from './linkProof';

/** Столько ждём ответа. Дальше человеку честнее сказать «не дозвонились». */
const TIMEOUT_MS = 12_000;
/** Потолок ответа: gist бывает большим, а разбирать мегабайты незачем. */
const MAX_BODY_CHARS = 512 * 1024;

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

type Deps = { fetch?: FetchLike };

function pickFetch(deps?: Deps): FetchLike | null {
  const f = deps?.fetch ?? (typeof fetch === 'function' ? (fetch as unknown as FetchLike) : null);
  return f;
}

async function getText(url: string, headers: Record<string, string>, deps?: Deps): Promise<{ status: number; body: string } | null> {
  const f = pickFetch(deps);
  if (!f) return null;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const res = await f(url, { headers, ...(controller ? { signal: controller.signal } : {}) });
    const raw = await res.text();
    return { status: res.status, body: raw.length > MAX_BODY_CHARS ? raw.slice(0, MAX_BODY_CHARS) : raw };
  } catch (e) {
    log.warn('link_proof_fetch_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
 * Проверить публичный gist.
 *
 * Порядок проверок — от дешёвого к дорогому и от «ошибся адресом» к «не
 * сходится по существу»: сначала разбор адреса, потом ответ площадки, потом
 * автор, и только потом подпись. Иначе человек, вставивший чужой gist,
 * получил бы «подпись не сходится» вместо «это не ваш gist».
 */
export async function checkGithubGist(url: string, expect: ProofExpectation, deps?: Deps): Promise<ProofCheck> {
  const id = parseGistId(url);
  if (!id) return { ok: false, reason: 'bad_url' };

  const res = await getText(`https://api.github.com/gists/${id}`, {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }, deps);
  if (!res) return { ok: false, reason: 'network' };
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (res.status !== 200) return { ok: false, reason: 'network' };

  let doc: unknown;
  try {
    doc = JSON.parse(res.body);
  } catch {
    return { ok: false, reason: 'network' };
  }
  const o = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const owner = (o.owner && typeof o.owner === 'object' ? (o.owner as Record<string, unknown>).login : null);
  if (typeof owner !== 'string') return { ok: false, reason: 'not_found' };
  if (owner.toLowerCase() !== expect.handle.toLowerCase()) return { ok: false, reason: 'owner_mismatch' };

  // Содержимое всех файлов подряд: в каком из них лежит строка — дело автора.
  const files = (o.files && typeof o.files === 'object' ? o.files : {}) as Record<string, unknown>;
  const texts: string[] = [String(o.description ?? '')];
  for (const f of Object.values(files)) {
    const content = (f && typeof f === 'object' ? (f as Record<string, unknown>).content : null);
    if (typeof content === 'string') texts.push(content);
  }
  return verifyProofInText(texts.join('\n'), expect);
}

/**
 * Проверить запись в X.
 *
 * Имя автора берётся из ответа площадки (`author_url`), а не из вставленного
 * адреса: адрес человек пишет сам, и доверять ему — значит не проверять
 * ничего. Совпадение имени в адресе проверяется лишь как ранняя подсказка об
 * опечатке.
 */
export async function checkXPost(url: string, expect: ProofExpectation, deps?: Deps): Promise<ProofCheck> {
  const parsed = parseTweetUrl(url);
  if (!parsed) return { ok: false, reason: 'bad_url' };

  const target = `https://x.com/${parsed.handle}/status/${parsed.id}`;
  const res = await getText(
    `https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(target)}`,
    { Accept: 'application/json' },
    deps
  );
  if (!res) return { ok: false, reason: 'network' };
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (res.status !== 200) return { ok: false, reason: 'network' };

  let doc: unknown;
  try {
    doc = JSON.parse(res.body);
  } catch {
    return { ok: false, reason: 'network' };
  }
  const o = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const authorUrl = typeof o.author_url === 'string' ? o.author_url : '';
  const author = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i.exec(authorUrl)?.[1];
  if (!author) return { ok: false, reason: 'not_found' };
  if (author.toLowerCase() !== expect.handle.toLowerCase()) return { ok: false, reason: 'owner_mismatch' };

  const html = typeof o.html === 'string' ? o.html : '';
  return verifyProofInText(html, expect);
}

/** Одна дверь: площадку выбирает вызывающий, а не разметка. */
export async function checkLinkProof(url: string, expect: ProofExpectation, deps?: Deps): Promise<ProofCheck> {
  return expect.platform === 'github' ? checkGithubGist(url, expect, deps) : checkXPost(url, expect, deps);
}
