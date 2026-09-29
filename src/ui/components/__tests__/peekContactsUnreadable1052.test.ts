/**
 * ДЕФЕКТ (v4.32.1052). Карточка человека выдавала непрочитанную адресную
 * книгу за «Не в контактах» — и предлагала «добавить» так, что это стирало
 * имя, данное контакту своей рукой.
 *
 * `listContacts()` — двузначная: `listContactsReadFor` отвечает `null`, когда
 * не прочитался указатель контактов (`readContactsFor` выходит на нём сразу,
 * до самих строк), а обёртка сводит это к пустому списку. Карточка на пустом
 * списке не находит собеседника и работает дальше так, будто его в книге нет.
 *
 * ЦЕНА складывается из двух частей.
 *
 * Первая — карточка говорит неправду о собственной записной книжке человека:
 * подсказка «Не в контактах», местная подпись заменена тем именем, которым
 * собеседник назвался сам (`peekIdentity` берёт `fallbackName`, когда контакта
 * нет), официальная галочка снята, «О себе» и ссылки пусты. Строка контакта
 * при этом цела — не прочитался указатель.
 *
 * Вторая тяжелее. Раз «не в контактах» — в листе «Ещё» появляется «Добавить в
 * контакты», и уходит оно с тем самым чужим именем: `handleAddContact` зовёт
 * `addContact(pair, raw, displayName)`, а `mergeExplicitContactRow` ставит
 * переданное имя ВЫШЕ хранимого (`patch.displayName || prev.displayName`).
 * Строка читается отдельно от указателя, поэтому защита v4.32.641
 * (`mayOverwrite`) здесь не срабатывает: запись проходит, и подпись, которую
 * человек дал контакту сам, молча заменяется на самоназвание собеседника.
 *
 * ПРАВКА. Карточка читает `listContactsRead()` и держит `bookUnknown`.
 * Подсказка становится «Список контактов не прочитался», пункт «Добавить в
 * контакты» называет причину и не нажимается, а сам обработчик отказывает
 * вслух — на случай, если до него дойдут мимо листа.
 *
 * ГРАНИЦЫ. Прочитанная книга работает как прежде: и «в контактах», и «не в
 * контактах — вы переписывались», и обычное «Добавить в контакты». Чтение не
 * повторяем: карточка открывается заново одним касанием, а повтор в цикле над
 * занятой базой стоит дороже, чем честная строка.
 */
import fs from 'fs';
import path from 'path';

import { hubMore, hubSettings, type HubFacts } from '../profileHubModel';
import { peekIdentity } from '../profilePeekModel';
import { mergeExplicitContactRow } from '../../../core/social/contactRowMerge';
import { CONTACTS_UNREADABLE_MESSAGE } from '../../../core/social/contacts';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from); if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = src.indexOf(to, a); if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

const PEEK = () => read('ui', 'components', 'UserProfilePeek.tsx');

const facts: HubFacts = {
  isSelf: false,
  inContacts: false,
  hasContactRecord: false,
  bookUnknown: false,
  blocked: false,
  blockUnknown: false,
  muted: false,
  copyGuard: false,
  copyGuardByPeer: false,
  disappearMs: null,
  convUnknown: false,
  reported: false,
  canOpenChat: true,
  inChat: false,
};

const addItem = (f: HubFacts) => hubMore(f).find((i) => i.id === 'add_contact');

describe('что карточка говорит о записной книжке', () => {
  it('непрочитанная книга названа непрочитанной, а не «Не в контактах»', () => {
    const id = peekIdentity({ contact: null, fallbackName: 'Аня', did: 'did:key:z1', isSelf: false, bookUnknown: true });
    expect(id.hint).toBe('Список контактов не прочитался');
  });

  it('прочитанная и пустая книга — прежнее «Не в контактах»', () => {
    const id = peekIdentity({ contact: null, fallbackName: 'Аня', did: 'did:key:z1', isSelf: false, bookUnknown: false });
    expect(id.hint).toBe('Не в контактах');
  });

  it('найденный контакт незнанием не задет', () => {
    const id = peekIdentity({
      contact: { displayName: 'Мама', implicit: false },
      fallbackName: 'Аня', did: 'did:key:z1', isSelf: false, bookUnknown: true,
    });
    expect(id.hint).toBe('В ваших контактах');
    expect(id.title).toBe('Мама');
  });

  it('своя карточка про чужую книгу не рассказывает', () => {
    const id = peekIdentity({ contact: null, did: 'did:key:z1', isSelf: true, bookUnknown: true });
    expect(id.hint).toBe('Это ваш профиль');
  });

  it('три исхода названы тремя разными строками', () => {
    const hints = [
      peekIdentity({ contact: null, did: 'd', isSelf: false, bookUnknown: false }).hint,
      peekIdentity({ contact: null, did: 'd', isSelf: false, bookUnknown: true }).hint,
      peekIdentity({ contact: { displayName: '', implicit: true }, did: 'd', isSelf: false, bookUnknown: false }).hint,
    ];
    expect(new Set(hints).size).toBe(3);
  });
});

describe('«Добавить в контакты» на непрочитанной книге', () => {
  it('называет причину и не нажимается', () => {
    const item = addItem({ ...facts, bookUnknown: true });
    expect(item?.label).toBe('Добавить в контакты (список не прочитался)');
    expect(item?.disabled).toBe(true);
  });

  it('ГРАНИЦА: на прочитанной книге — прежний пункт без оговорок', () => {
    const item = addItem({ ...facts, bookUnknown: false });
    expect(item?.label).toBe('Добавить в контакты');
    expect(item?.disabled).toBeFalsy();
  });

  it('у того, кто в контактах, пункта нет ни при каком незнании', () => {
    expect(addItem({ ...facts, inContacts: true, bookUnknown: true })).toBeUndefined();
    expect(addItem({ ...facts, inContacts: true, bookUnknown: false })).toBeUndefined();
  });

  it('обработчик отказывает вслух, даже если до него дошли мимо листа', () => {
    const body = slice(PEEK(), 'const handleAddContact = useCallback', 'const handleSubmitRename');
    expect(body).toContain('if (bookUnknown) {');
    expect(body).toContain('showError(CONTACTS_UNREADABLE_MESSAGE);');
    // Отказ обязан стоять ДО самой записи.
    expect(body.indexOf('bookUnknown')).toBeLessThan(body.indexOf('await addContact('));
  });

  it('остальные пункты листа незнанием не задеты', () => {
    const known = hubMore({ ...facts, bookUnknown: false }).map((i) => i.id);
    const unknown = hubMore({ ...facts, bookUnknown: true }).map((i) => i.id);
    expect(unknown).toEqual(known);
    expect(hubSettings({ ...facts, bookUnknown: true })).toEqual(hubSettings({ ...facts, bookUnknown: false }));
  });
});

describe('карточка читает различающим чтением', () => {
  it('зовёт listContactsRead и отличает null от пустоты', () => {
    const body = slice(PEEK(), 'const all = await listContactsRead();', 'setRenameDraft(');
    expect(body).toContain('setBookUnknown(all === null);');
    expect(body).toContain('all?.find((c) => c.peerPublicKey === resolved.pubB64) ?? null');
  });

  it('двузначная listContacts из карточки ушла совсем', () => {
    expect(PEEK()).not.toContain('await listContacts()');
    expect(PEEK()).toContain('listContactsRead,');
  });

  it('отметка сбрасывается на смену собеседника', () => {
    const body = slice(PEEK(), 'setContact(null);', 'setRenaming(false);');
    expect(body).toContain('setBookUnknown(false);');
  });

  it('признак доезжает и до подсказки, и до листа действий', () => {
    const idm = slice(PEEK(), 'const identity = useMemo', 'const displayName');
    expect(idm).toContain('bookUnknown,');
    expect(idm).toContain('bookUnknown, resolved, isSelf, own, usernameHint]');
    const fm = slice(PEEK(), 'const facts: HubFacts = useMemo', 'const quickActions');
    expect(fm).toContain('bookUnknown,');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: слияние строки ставит переданное имя выше хранимого', () => {
    // Это и есть механизм потери: «добавить» с чужим именем перезаписывает своё.
    const prev = JSON.stringify({ displayName: 'Мама', symKey: 'x', implicit: true });
    const merged = JSON.parse(mergeExplicitContactRow(prev, { displayName: 'anna_1994', symKeyB64: 'y' }));
    expect(merged.displayName).toBe('anna_1994');
    // …а без переданного имени хранимое цело — значит дело именно в том, что
    // карточка подставляла туда самоназвание собеседника.
    const kept = JSON.parse(mergeExplicitContactRow(prev, { displayName: '', symKeyB64: 'y' }));
    expect(kept.displayName).toBe('Мама');
  });

  it('ПОВОД ЖИВ: без контакта в карточку идёт имя, которым назвался собеседник', () => {
    const id = peekIdentity({ contact: null, fallbackName: 'anna_1994', did: 'did:key:z1', isSelf: false, bookUnknown: true });
    expect(id.contactName).toBe('anna_1994');
  });

  it('ЗАКРЕПКА: указатель контактов читается отдельно от строк', () => {
    const src = read('core', 'social', 'contacts.ts');
    const body = slice(src, 'async function readContactsFor', 'const badIds');
    expect(body).toContain("await scopedKvTryGetFor(pid, 'contacts_index')");
    expect(body).toContain('if (read === null) return null;');
    expect(body).toContain("if (!raw) return { contacts: [], missing: 0 };");
  });

  it('ЗАКРЕПКА: поле в HubFacts обязательное, забыть его нельзя', () => {
    const decl = slice(read('ui', 'components', 'profileHubModel.ts'), 'export type HubFacts = {', 'export function');
    expect(decl).toContain('bookUnknown: boolean;');
    expect(decl).not.toContain('bookUnknown?: boolean;');
  });

  it('ЗАКРЕПКА: текст отказа русский и про список, а не про строку', () => {
    expect(CONTACTS_UNREADABLE_MESSAGE).toContain('список контактов');
    expect(CONTACTS_UNREADABLE_MESSAGE).not.toMatch(/[A-Za-z]{4,}/);
  });
});
