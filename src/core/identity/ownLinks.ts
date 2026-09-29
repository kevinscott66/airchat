/**
 * Свои привязки (GitHub / X) одним списком — v4.32.575.
 *
 * Раньше это жило внутри profileSync и знало только про конверт. Теперь список
 * нужен ещё и карточке профиля: она показывает те же привязки, что уезжают
 * собеседнику, и собирать их вторым способом нельзя — два способа неизбежно
 * разойдутся, и человек увидит у себя не то, что видят другие.
 *
 * Имя без доказательства попадает в список тоже: это допустимое состояние (см.
 * profileLinks), и получатель покажет его как заявленное. Молча прятать такое
 * имя нельзя — тогда поле просто исчезнет у всех, кто не захотел ничего
 * публиковать.
 */
import { normalizeHandle, normalizeProofUrl, readLinkProofRecord } from './linkProof';
import type { ProfileLink } from './profileLinks';
import { ownFieldTryGet, ownFieldTryGetFor, type OwnProfileKey } from './ownProfile';

const FIELDS = [
  { p: 'github' as const, handle: 'user_github' as const, proof: 'user_github_proof' as const },
  { p: 'x' as const, handle: 'user_twitter' as const, proof: 'user_twitter_proof' as const },
];

/**
 * v4.32.1023: ячейки спрашиваются различающей формой, и `'unreadable'` доходит
 * до вызывающего. Прежде здесь стояла сводящая форма, и не открывшаяся ячейка
 * значила «привязки нет» — а пустой список привязок получатель записывает
 * поверх своего (`peerLinks: []`, см. contacts): отказ базы отвязывал человеку
 * учётные записи у всех его контактов разом.
 */
async function collect(
  get: (key: OwnProfileKey) => Promise<{ text: string | null } | null>,
): Promise<ProfileLink[] | null | 'unreadable'> {
  const out: ProfileLink[] = [];
  for (const f of FIELDS) {
    const handle = await get(f.handle);
    if (handle === null) return 'unreadable';
    const h = normalizeHandle(f.p, handle.text);
    if (!h) continue;
    const proof = await get(f.proof);
    if (proof === null) return 'unreadable';
    const rec = readLinkProofRecord(proof.text);
    out.push({ p: f.p, h, u: rec ? normalizeProofUrl(f.p, rec.url) : null });
  }
  return out.length > 0 ? out : null;
}

/**
 * Привязки заданного профиля — для рассылки конверта.
 *
 * `'unreadable'` — хотя бы одна ячейка на месте и не открылась. Рассылке этого
 * довольно, чтобы промолчать до следующего захода.
 */
export async function ownLinksTryFor(pid: number): Promise<ProfileLink[] | null | 'unreadable'> {
  return await collect((key) => ownFieldTryGetFor(pid, key));
}

/**
 * Привязки текущего профиля — для своей карточки. Здесь «не прочитали» и «не
 * задано» сводятся к одному: показать нечего и там, и там, а записывать
 * карточка отсюда ничего не будет.
 */
export async function ownLinks(): Promise<ProfileLink[] | null> {
  const links = await collect(ownFieldTryGet);
  return links === 'unreadable' ? null : links;
}
