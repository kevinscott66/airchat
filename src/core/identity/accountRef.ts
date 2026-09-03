/**
 * accountRef — идентификатор аккаунта для программ, а не для экрана (v4.32.573).
 *
 * До этой версии строка `AC-XXXXX-XXXXX` висела в профиле и в карточке
 * собеседника. Показывать её оказалось лишним: сверять собеседника по ней
 * никто не станет, пока рядом лежит адрес для связи (DID) — он и точнее, и
 * уже подписан, — а на экране она читалась как «номер», который надо кому-то
 * диктовать. Телеграм здесь ведёт себя ровно так же: числовой id есть у
 * каждого и им пользуются боты, но человеку его не показывают.
 *
 * Поэтому идентификатор никуда не делся, он просто перестал быть надписью.
 * Этот модуль — единственная дверь к нему для кода:
 *
 *  - `accountRefFor(did)` — ссылка на любой аккаунт, чей DID уже известен:
 *    из конверта профиля, из контакта, из входящего сообщения. Это чистая
 *    функция от ключа, поэтому сеть для неё не нужна и спросить некого.
 *  - `ownAccountRefInfo()` — своя ссылка вместе с датой заведения аккаунта.
 *    Дата лежит в карточке профиля с самого начала (`Profile.createdAt`) и
 *    до сих пор нигде не читалась.
 *  - `readAccountRef(value)` — разбор набранной руками строки: принимает
 *    нижний регистр, пробелы и путаницу `0/O`, `1/I`, отказывает всему, что
 *    не аккаунт (группе и каналу в том числе).
 *
 * Зачем это отдельным файлом, а не вызовом `publicIdFor('account', did)` по
 * месту: у `publicId` три вида идентификаторов и ни одного представления о
 * профилях, а вызывающему нужен ровно аккаунт и обычно ещё дата. Разложенный
 * по месту, этот вызов через полгода разъедется — где-то с 'account', где-то
 * с 'group' по недосмотру, и оба варианта будут выглядеть правильно.
 */
import { publicIdFor, publicIdKind, readPublicId } from "./publicId";
import { profileManager } from "./profileManager";
import { log } from "../logger";

/** Ссылка на аккаунт и то, что о нём известно локально. */
export type AccountRefInfo = {
  /** `AC-XXXXX-XXXXX`. Пустая строка означает «нет DID», а не «нет ссылки». */
  ref: string;
  /** Ключ аккаунта: ссылка выводится из него и без него не существует. */
  did: string;
  /** Когда аккаунт заведён на этом устройстве, мс epoch. 0 — неизвестно. */
  createdAt: number;
};

/**
 * Ссылка на аккаунт по его DID.
 *
 * Чистая функция: одинаковый DID всегда даёт одинаковую строку на любом
 * устройстве и в любой версии. На этом и держится смысл ссылки как реф-кода —
 * бот, получивший её от одного человека, узнаёт по ней того же самого
 * отправителя, когда тот придёт сам.
 */
export function accountRefFor(did: string | null | undefined): string {
  return publicIdFor("account", did);
}

/** Ссылка и дата заведения названного профиля. null — такого профиля нет. */
export function accountRefInfoFor(pid: number): AccountRefInfo | null {
  try {
    const p = profileManager.getAllProfiles().find((x) => x.id === pid);
    if (!p) return null;
    return { ref: accountRefFor(p.did), did: p.did, createdAt: p.createdAt };
  } catch (e) {
    log.warn("account_ref_lookup_failed", {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Своя ссылка. Пустая строка — профиля ещё нет (первый запуск, до создания). */
export function ownAccountRef(): string {
  return ownAccountRefInfo()?.ref ?? "";
}

/** Своя ссылка вместе с датой заведения аккаунта. */
export function ownAccountRefInfo(): AccountRefInfo | null {
  try {
    const p = profileManager.getActiveProfile();
    if (!p) return null;
    return { ref: accountRefFor(p.did), did: p.did, createdAt: p.createdAt };
  } catch (e) {
    log.warn("account_ref_own_failed", {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Разобрать набранную строку как ссылку на аккаунт.
 *
 * Отдельно от `readPublicId`, потому что тот принимает и `GR-`, и `CH-`:
 * реф-код группы, поданный боту вместо аккаунта, — это молча неверный ответ,
 * а не ошибка ввода, и ловить его надо здесь, а не потом по последствиям.
 */
export function readAccountRef(value: unknown): string | null {
  const id = readPublicId(value);
  return id && publicIdKind(id) === "account" ? id : null;
}

/** Ссылка ли это на аккаунт. */
export function isAccountRef(value: unknown): boolean {
  return readAccountRef(value) !== null;
}
