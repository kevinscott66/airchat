/**
 * v4.32.997: листы получателей выдавали отказ чтения за «получателей нет».
 *
 * Дефект. Три подборщика — «Поделиться» в ленте, «Переслать» в чате и раздел
 * «Добавить участников» при создании группы — читали контакты и группы через
 * `listContacts`/`listGroups`. Оба входа гасят отказ базы в пустой список
 * (`?? []` поверх трёхсостоянийных `listContactsReadFor`/`readGroupRows`),
 * поэтому обещание в `.catch` рядом с каждым вызовом не сбывалось ни разу.
 *
 * Цена. Разбор пустоты в этих листах уже написан и уже врёт впустую: исход
 * `'failed'` ленты вместе с текстом `feed.shareTargetsFailed` заведён в
 * v4.32.534, надпись окна пересылки «Не удалось прочитать список чатов.
 * Нажмите, чтобы повторить» — в v4.32.879, докблок про исчезающий раздел
 * участников — в v4.32.639. Ни один из трёх не мог включиться: до них
 * доезжал пустой список, и человек читал приговор — «переслать некому»,
 * «получателей нет», а раздел участников просто исчезал, и группа заводилась
 * пустой при целой на диске записной книжке.
 *
 * Правка. Те же три места читают `listContactsRead()` и `listGroupsRead(pid)`,
 * а `null` переводят в уже существовавший исход отказа.
 *
 * Границы. Пустой прочитанный список остаётся пустым: «переслать некому» и
 * «получателей нет» — правда, когда контактов и правда нет, и эти надписи
 * не тронуты.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Код без комментариев: докблок не должен закрывать собой проверку. */
function codeOnly(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/** Одно место файла — чтобы совпадение не прилетело от соседа. */
function slice(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = text.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
}

const FEED = (): string => codeOnly(read('ui/screens/FeedScreen.tsx'));
const FORWARD = (): string => codeOnly(read('ui/components/modals/chat/ChatForwardModal.tsx'));
const CREATE = (): string => codeOnly(read('ui/components/modals/groups/GroupCreateModal.tsx'));

describe('подборщики получателей читают трёхсостоянийными входами', () => {
  it('лента: лист «Поделиться» отличает пустоту от отказа', () => {
    const body = slice(FEED(), 'setShareTargets(\'loading\');', 'return () => { alive = false; };');
    expect(body).toContain('Promise.all([listContactsRead(), listGroupsRead(pid)])');
    expect(body).toContain('if (ctacts === null || grps === null) {');
    expect(body).toContain("setShareTargets('failed');");
    expect(body).not.toContain('listContacts(), listGroups(pid)');
  });

  it('окно пересылки отличает «переслать некому» от «не прочитали»', () => {
    const body = slice(FORWARD(), "setLoad('loading');", 'return () => { alive = false; };');
    expect(body).toContain('Promise.all([listContactsRead(), listGroupsRead(pid)])');
    expect(body).toContain('if (cs === null || gs === null) {');
    expect(body).toContain("setLoad('failed');");
    expect(body).not.toContain('listContacts(), listGroups(pid)');
  });

  it('создание группы: раздел участников не исчезает молча', () => {
    const create = CREATE();
    expect(create).toContain('void listContactsRead()');
    expect(create).toContain('if (all === null) {');
    expect(create).toContain('Не удалось прочитать контакты. Участников можно добавить потом.');
    expect(create).not.toContain('void listContacts()');
  });

  it('ни один из трёх больше не зовёт гасящие входы', () => {
    const feedShare = slice(FEED(), 'setShareTargets(\'loading\');', 'return () => { alive = false; };');
    expect(feedShare).not.toMatch(/\blistContacts\(\)/);
    expect(feedShare).not.toMatch(/\blistGroups\(/);
    expect(FORWARD()).not.toMatch(/\blistContacts\(\)/);
    expect(FORWARD()).not.toMatch(/\blistGroups\(/);
    expect(CREATE()).not.toMatch(/\blistContacts\(\)/);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('короткие входы и правда гасят отказ в пустой список', () => {
    const contacts = read('core/social/contacts.ts');
    expect(contacts).toContain('return (await listContactsReadFor(ownerProfileId)) ?? [];');
    const local = read('core/storage/local.ts');
    expect(local).toContain('return (await listGroupsRead(ownerProfileId)) ?? [];');
  });

  it('трёхсостоянийные входы на месте и обещают null именно на отказе', () => {
    const contacts = read('core/social/contacts.ts');
    expect(contacts).toContain('export async function listContactsRead(): Promise<Contact[] | null>');
    const local = read('core/storage/local.ts');
    expect(local).toContain('export async function listGroupsRead(ownerProfileId: number): Promise<GroupRow[] | null>');
  });

  it('разбор пустоты в листах был написан заранее и никуда не делся', () => {
    const fwd = read('ui/components/modals/chat/forwardListState.ts');
    expect(fwd).toContain("export const FWD_FAILED_TEXT = 'Не удалось прочитать список чатов.\\nНажмите, чтобы повторить';");
    expect(fwd).toContain("if (load === 'failed') return 'failed';");
    const ru = JSON.parse(read('i18n/ru.json')) as { feed: Record<string, string> };
    expect(typeof ru.feed.shareTargetsFailed).toBe('string');
    expect(ru.feed.shareTargetsFailed.length).toBeGreaterThan(3);
  });

  it('прочитанная пустота по-прежнему называется своими словами', () => {
    const fwd = read('ui/components/modals/chat/forwardListState.ts');
    expect(fwd).toContain("export const FWD_EMPTY_TEXT = 'Переслать некому: нет ни контактов, ни групп';");
    expect(read('ui/screens/FeedScreen.tsx')).toContain("t('feed.shareNoTargets')");
    expect(read('ui/components/modals/groups/GroupCreateModal.tsx'))
      .toContain('{type === \'group\' && contacts.length > 0 ? (');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: листы на месте и собираются из двух источников', () => {
  it('лента складывает контакты и неархивные группы', () => {
    const body = slice(FEED(), 'setShareTargets(\'loading\');', 'return () => { alive = false; };');
    expect(body).toContain('setShareContacts(');
    expect(body).toContain('setShareGroups(');
    expect(body).toContain('.filter((g) => !g.archived)');
  });

  it('окно пересылки складывает контакты и группы, и умеет повторить', () => {
    const fwd = FORWARD();
    expect(fwd).toContain('const listData: FwdItem[] = [');
    expect(fwd).toContain('setAttempt((n) => n + 1)');
    expect(fwd).toContain('[visible, pid, attempt]');
  });

  it('закрытый лист не доедает свой ответ', () => {
    for (const body of [
      slice(FEED(), 'setShareTargets(\'loading\');', 'return () => { alive = false; };'),
      slice(FORWARD(), "setLoad('loading');", 'return () => { alive = false; };'),
    ]) {
      expect(body).toContain('if (!alive) return;');
    }
  });
});
