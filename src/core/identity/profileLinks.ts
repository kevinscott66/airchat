/**
 * profileLinks — привязанные учётные записи в том виде, в каком они едут
 * собеседнику (v4.32.575).
 *
 * До этой версии привязка была делом одного устройства: человек доказывал
 * владение @именем, приложение записывало доказательство себе в базу и
 * показывало галочку — ему же. Собеседник не видел ни имени, ни галочки, и
 * весь смысл проверки пропадал ровно там, где он нужен: узнать, тот ли это
 * человек, хочет как раз другой.
 *
 * Поэтому ссылки едут в конверте профиля рядом с именем и фотографией. Едет
 * при этом не «галочка», а то, из чего её можно вывести самому: имя на
 * площадке и АДРЕС публикации. Разница принципиальная и ровно та же, что у
 * официальной галочки (identity/verification): признак «подтверждено», если
 * его прислать готовым, подтверждает только то, что отправитель так написал.
 * Адрес публикации проверяется — стороной получателя, её же сетью и её же
 * глазами (см. peerLinkVerify).
 *
 * Имя без адреса — допустимое состояние, а не ошибка: человек вправе указать
 * себя, ничего не публикуя. Такое имя показывается как заявленное.
 *
 * Модуль чистый: только правила площадок (linkPlatform), никакой сети и базы.
 */
import { normalizeHandle, normalizeProofUrl, type LinkPlatform } from './linkPlatform';

export type ProfileLink = {
  /** Площадка. */
  p: LinkPlatform;
  /** Имя учётной записи на ней. */
  h: string;
  /** Адрес публикации с доказательством. null — имя только заявлено. */
  u: string | null;
};

/** По одной записи на площадку — больше в конверте взяться неоткуда. */
export const MAX_PROFILE_LINKS = 2;

const PLATFORMS: LinkPlatform[] = ['github', 'x'];

function readOne(v: unknown): ProfileLink | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const p = PLATFORMS.find((x) => x === o.p);
  if (!p) return null;
  const h = normalizeHandle(p, o.h);
  if (!h) return null;
  // Негодный адрес не отменяет имени: имя останется заявленным. Отбросить
  // запись целиком значило бы наказать за испорченную ссылку тем, что имя
  // исчезнет вовсе.
  return { p, h, u: normalizeProofUrl(p, o.u) };
}

/**
 * Разобрать список из недоверенного ввода: чужого конверта или своей же
 * строки в базе, которая могла приехать из резервной копии.
 *
 * Возвращает null, когда показывать нечего: так поле просто не попадает ни в
 * конверт, ни в запись контакта, и пустой массив не отличается от отсутствия.
 */
export function sanitizeProfileLinks(v: unknown): ProfileLink[] | null {
  if (!Array.isArray(v)) return null;
  const out: ProfileLink[] = [];
  const seen = new Set<LinkPlatform>();
  for (const item of v.slice(0, MAX_PROFILE_LINKS * 4)) {
    const link = readOne(item);
    if (!link || seen.has(link.p)) continue;
    seen.add(link.p);
    out.push(link);
    if (out.length >= MAX_PROFILE_LINKS) break;
  }
  return out.length > 0 ? out : null;
}

/** Одна площадка из списка — списки короткие, поиск дешевле индекса. */
export function findProfileLink(links: ProfileLink[] | null | undefined, p: LinkPlatform): ProfileLink | null {
  return links?.find((l) => l.p === p) ?? null;
}

/**
 * Строка для сравнения «то же самое или уже другое».
 *
 * Нужна рассылке профиля: её ключ версии — свёртка содержимого, и без ссылок
 * в этой свёртке новая привязка не уехала бы никому до следующей правки имени.
 */
export function profileLinksKey(links: ProfileLink[] | null | undefined): string {
  if (!links || links.length === 0) return '';
  return links.map((l) => `${l.p}:${l.h}:${l.u ?? ''}`).join(',');
}
