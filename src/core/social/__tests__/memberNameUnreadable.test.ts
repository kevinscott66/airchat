/**
 * Имя участника группы, которое ключ этого устройства не открывает (v4.32.595).
 *
 * Состав группы читался двумя состояниями:
 * `nameOrNull(decryptAtRestNullable(r.display_name, dek))`. И «человек не
 * назвался», и «имя есть, но ключ его не открыл» приходили одинаковым `null`.
 *
 * На экране состава это выглядело как подпись коротким ключом — то есть беда
 * пряталась под видом обычной безымянной строки. Но хуже другое: по этому же
 * `null` работает `resolveMember`, поиск участника по написанному после
 * команды. Весь модуль написан ради одного правила — совпало несколько,
 * значит, спросить; иначе участник назовётся чужим именем и уведёт на себя
 * `/promote`. Участник с непрочитанным именем в сравнение по имени не
 * попадал ВООБЩЕ, и вторая «Аня» становилась единственной: команда исполнялась
 * без вопроса, хотя однозначность никем не доказана.
 *
 * Здесь закреплено: состав читается тремя состояниями, экран показывает
 * пометку, а имя решает только тогда, когда прочитаны все имена.
 */
import fs from 'fs';
import path from 'path';

import { UNREADABLE_NAME_TEXT } from '../../storage/unreadableText';
import { ambiguityMessage, memberLabel, resolveMember } from '../../../ui/utils/memberLookup';
import { shortIdentity } from '../../../ui/identity/shortId';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const LOOKUP = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'utils', 'memberLookup.ts'), 'utf8');
const GROUPS = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');
const SHEET = () =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'groups', 'GroupMemberSheetModal.tsx'),
    'utf8'
  );

/** Кусок файла между двумя опорами — чтобы утверждение не ловило соседей. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const anya = { peerPubB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAk3f9d2a1c', displayName: 'Аня' };
const petr = { peerPubB64: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCf00dbeef', displayName: 'Пётр' };
/** Тот, чьё имя не прочиталось: сравнивать с запросом нечего. */
const blind = {
  peerPubB64: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBb7c10099',
  displayName: null,
  displayNameUnreadable: true,
};

describe('чтение состава группы', () => {
  it('имя участника читается состоянием, а не «null или строка»', () => {
    const body = slice(LOCAL(), 'export async function listGroupMembers(', 'export async function recountGroupMembers(');
    expect(body).toContain('...readMemberName(r.display_name, dek),');
    expect(body).not.toContain('nameOrNull(decryptAtRestNullable(r.display_name');
  });

  it('строка состава несёт признак непрочитанного имени', () => {
    const type = slice(LOCAL(), 'export type GroupMemberRow = {', 'export type GroupMessageRow = {');
    expect(type).toMatch(/^ {2}displayNameUnreadable\?: boolean;$/m);
  });

  it('признак не участвует в записи: он про нас, а не про участника', () => {
    const write = slice(LOCAL(), 'export async function upsertGroupMember(', 'export async function listGroupMembers(');
    expect(write).not.toContain('displayNameUnreadable');
  });
});

describe('поиск участника не считает непрочитанных отсутствующими', () => {
  it('без непрочитанных решение прежнее', () => {
    expect(resolveMember([anya, petr], 'Аня')).toEqual({ kind: 'found', member: anya });
  });

  it('одно совпадение при непрочитанном имени рядом — не ответ, а уточнение', () => {
    const r = resolveMember([anya, petr, blind], 'Аня');
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') throw new Error('unreachable');
    expect(r.candidates).toContain(anya);
    expect(r.candidates).toContain(blind);
    expect(r.candidates).not.toContain(petr);
  });

  it('непрочитанный сам по себе никого не находит', () => {
    // Запрос не совпал ни с одним прочитанным именем: единственный кандидат —
    // непрочитанный, и это именно «уточните», а не «нашёл».
    const r = resolveMember([anya, petr, blind], 'Марина');
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') throw new Error('unreachable');
    expect(r.candidates).toEqual([blind]);
  });

  it('без непрочитанных промах остаётся промахом', () => {
    expect(resolveMember([anya, petr], 'Марина')).toEqual({ kind: 'none' });
  });

  it('ключ решает и при непрочитанном имени: его не шифруют', () => {
    expect(resolveMember([anya, petr, blind], shortIdentity(blind.peerPubB64))).toEqual({
      kind: 'found',
      member: blind,
    });
  });
});

describe('как непрочитанного называют', () => {
  it('в списке уточнения вместо имени стоит пометка', () => {
    expect(memberLabel(blind)).toBe(`${UNREADABLE_NAME_TEXT} · ${shortIdentity(blind.peerPubB64)}`);
  });

  it('безымянный участник по-прежнему подписан одним ключом', () => {
    expect(memberLabel({ peerPubB64: petr.peerPubB64, displayName: null })).toBe(shortIdentity(petr.peerPubB64));
  });

  it('единственного кандидата не называют «несколькими»', () => {
    const msg = ambiguityMessage([blind]);
    expect(msg).not.toContain('Подходит несколько участников');
    expect(msg).toContain(UNREADABLE_NAME_TEXT);
    expect(msg).toContain('укажите ключ');
  });

  it('двоих и больше — по-прежнему «несколько»', () => {
    expect(ambiguityMessage([anya, blind])).toContain('Подходит несколько участников');
  });

  it('пометка берётся из общего списка, а не пишется строкой', () => {
    const src = LOOKUP();
    expect(src).toMatch(/^import \{[^}]*\bUNREADABLE_NAME_TEXT\b[^}]*\} from '\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
    expect(src).not.toContain("'Имя не удалось прочитать'");
  });
});

describe('состав на экране', () => {
  it('строка участника подписывается общим правилом показа', () => {
    const src = GROUPS();
    expect(src).toContain('shownName(item.displayName, item.displayNameUnreadable, shortIdentity(item.peerPubB64))');
    expect(src).toContain('shownName(m.displayName, m.displayNameUnreadable, shortIdentity(m.peerPubB64))');
  });

  it('непрочитанное имя окрашено предупреждением, а не обычным цветом', () => {
    expect(GROUPS()).toContain('item.displayNameUnreadable ? colors.warning');
  });

  it('карточка участника показывает то же самое', () => {
    const src = SHEET();
    expect(src).toContain('shownName(member.displayName, member.displayNameUnreadable, shortIdentity(member.peerPubB64))');
    expect(src).toContain('member.displayNameUnreadable ? colors.warning');
    expect(src).toMatch(/^import \{ shownName \} from '(\.\.\/){4}core\/social\/unreadableName';$/m);
  });
});
