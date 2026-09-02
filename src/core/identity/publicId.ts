/**
 * Постоянный идентификатор аккаунта, группы и канала (v4.32.540).
 *
 * Неизменяемые ключи в приложении были и раньше: аккаунт — это его публичный
 * ключ, группа — её uuid. Но человеку не показывали ни того, ни другого. На
 * экране был только юзернейм, а юзернейм меняют: после смены собеседник не мог
 * ни назвать, ни сверить того, с кем переписывается, и «тот же ли это человек»
 * решалось по имени и фотографии — то есть по тому, что подделывается за
 * минуту.
 *
 * Здесь ключ превращается в короткую строку, которую можно продиктовать вслух.
 * Свойства, ради которых всё это:
 *
 * - Выводится ТОЛЬКО из ключа (uuid). Переименование, смена юзернейма, аватара
 *   и описания его не трогают — поменять его нельзя, не заведя новый аккаунт.
 * - Приставка говорит, что это: `AC` — аккаунт, `GR` — группа, `CH` — канал.
 *   Приставка входит в хэш, поэтому один и тот же uuid у группы и у канала
 *   даёт разные строки — их нельзя перепутать, сравнивая хвосты.
 * - Алфавит Крокфорда: без `I`, `L`, `O` и `U`, поэтому единицу с «i» и ноль с
 *   «O» не спутать, а `readPublicId` принимает и путаницу, если её всё-таки
 *   набрали.
 *
 * 50 бит sha256 — это ~1.1e15 значений; на всём мыслимом числе групп и
 * аккаунтов совпадение остаётся невероятным, а строка помещается в две
 * пятёрки. Это НЕ замена ключу: сверка подлинности по-прежнему делается
 * ключом, а идентификатор — способ назвать собеседника словами.
 */
import { sha256 } from '@noble/hashes/sha2.js';

export type PublicIdKind = 'account' | 'group' | 'channel';

const PREFIX: Record<PublicIdKind, string> = {
  account: 'AC',
  group: 'GR',
  channel: 'CH',
};

/** Крокфорд: без I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Сколько символов после приставки. 10 × 5 бит = 50 бит хэша. */
const BODY_LEN = 10;

function encodeBody(digest: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (out.length < BODY_LEN) {
    acc = (acc << 8) | digest[i++]!;
    bits += 8;
    while (bits >= 5 && out.length < BODY_LEN) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  return out;
}

/**
 * Идентификатор для показа. `seed` — публичный ключ аккаунта в base64 либо
 * uuid группы; пустой seed идентификатора не имеет, и подставлять вместо него
 * что-то своё нельзя: пустая строка честнее выдуманной.
 */
export function publicIdFor(kind: PublicIdKind, seed: string | null | undefined): string {
  const value = (seed ?? '').trim();
  if (!value) return '';
  // Приставка в тексте хэша: иначе группа и канал с одним uuid дали бы одно и
  // то же тело, и различала бы их только пара букв впереди.
  const digest = sha256(new TextEncoder().encode(`airchat:pubid:${PREFIX[kind]}:${value}`));
  const body = encodeBody(digest);
  return `${PREFIX[kind]}-${body.slice(0, 5)}-${body.slice(5)}`;
}

/**
 * Привести набранное человеком к каноническому виду. Принимает строку с
 * пробелами, в любом регистре, с дефисами и без, и лечит обычную путаницу
 * алфавита Крокфорда (`I`/`L` → `1`, `O` → `0`). `null` — это не наш
 * идентификатор.
 */
export function readPublicId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const flat = value
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  const m = /^(AC|GR|CH)([0-9A-Z]{10})$/.exec(flat);
  if (!m) return null;
  const body = m[2]!;
  for (const ch of body) if (!ALPHABET.includes(ch)) return null;
  return `${m[1]}-${body.slice(0, 5)}-${body.slice(5)}`;
}

/** Что это за идентификатор. `null` — строка не наша. */
export function publicIdKind(value: unknown): PublicIdKind | null {
  const id = readPublicId(value);
  if (!id) return null;
  const head = id.slice(0, 2);
  return head === 'AC' ? 'account' : head === 'GR' ? 'group' : 'channel';
}
