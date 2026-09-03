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
import { ownFieldGet, ownFieldGetFor, type OwnProfileKey } from './ownProfile';

const FIELDS = [
  { p: 'github' as const, handle: 'user_github' as const, proof: 'user_github_proof' as const },
  { p: 'x' as const, handle: 'user_twitter' as const, proof: 'user_twitter_proof' as const },
];

async function collect(get: (key: OwnProfileKey) => Promise<string | null>): Promise<ProfileLink[] | null> {
  const out: ProfileLink[] = [];
  for (const f of FIELDS) {
    const h = normalizeHandle(f.p, await get(f.handle));
    if (!h) continue;
    const rec = readLinkProofRecord(await get(f.proof));
    out.push({ p: f.p, h, u: rec ? normalizeProofUrl(f.p, rec.url) : null });
  }
  return out.length > 0 ? out : null;
}

/** Привязки заданного профиля — для рассылки конверта. */
export async function ownLinksFor(pid: number): Promise<ProfileLink[] | null> {
  return await collect((key) => ownFieldGetFor(pid, key));
}

/** Привязки текущего профиля — для своей карточки. */
export async function ownLinks(): Promise<ProfileLink[] | null> {
  return await collect(ownFieldGet);
}
