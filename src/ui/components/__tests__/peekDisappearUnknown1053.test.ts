/**
 * ДЕФЕКТ (v4.32.1053). Карточка человека печатала «Автоудаление: Выкл» там,
 * где строку разговора прочитать не удалось.
 *
 * `listConversations` — двузначная обёртка над `listConversationsRead`
 * (`local.ts`): отказ чтения она отдаёт пустым списком. Разговор в таком
 * списке не находится, `disappearMs` остаётся `null`, а
 * `formatDisappearLabel(null)` даёт слово «Выкл».
 *
 * ЦЕНА. Это утверждение о настройке безопасности, и оно неверно ровно тогда,
 * когда проверить его человек и пришёл. Таймер живёт не в этой строке: он
 * согласован с собеседником и едет в конверте каждого сообщения, поэтому
 * «Выкл» в карточке не выключает ничего — оно только обещает, что написанное
 * останется. Человек, которому важно обратное, получает это обещание молча:
 * `listConversations` ошибку гасит внутри себя, и `catch` вокруг вызова не
 * срабатывал никогда, то есть в журнале не оставалось даже следа.
 *
 * ПРАВКА. Карточка читает `listConversationsRead` и держит `convUnknown`.
 * Подпись становится той же, что уже показывает меню переписки с v4.32.1047:
 * «не удалось прочитать». Отказ заодно попадает в журнал — теперь по-честному.
 *
 * ГРАНИЦЫ. Кнопку «Без звука» не трогаем намеренно: её подпись и значок
 * называют действие («выключить звук»), а не состояние, и нажатие на
 * непрочитанной строке делает ровно то, что написано, — выключает звук. Врать
 * там нечему. Прочитанный разговор работает как прежде: и с таймером, и без.
 */
import fs from 'fs';
import path from 'path';

import { hubSettings, type HubFacts } from '../profileHubModel';
import { formatDisappearLabel } from '../../../core/social/disappearEnvelope';

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
  inContacts: true,
  hasContactRecord: true,
  bookUnknown: false,
  blocked: false,
  blockUnknown: false,
  muted: false,
  copyGuard: false,
  copyGuardByPeer: false,
  disappearMs: null,
  convUnknown: false,
  reported: false,
  reportUnknown: false,
  canOpenChat: true,
  inChat: false,
};

const disappear = (f: HubFacts) => hubSettings(f).find((i) => i.id === 'disappear');

describe('что карточка говорит об автоудалении', () => {
  it('непрочитанная строка не объявляется выключенным таймером', () => {
    expect(disappear({ ...facts, convUnknown: true, disappearMs: null })?.value)
      .toBe('не удалось прочитать');
  });

  it('ГРАНИЦА: прочитанная строка без таймера — прежнее «Выкл»', () => {
    expect(disappear({ ...facts, convUnknown: false, disappearMs: null })?.value)
      .toBe(formatDisappearLabel(null));
    expect(disappear({ ...facts, convUnknown: false, disappearMs: null })?.value).toBe('Выкл');
  });

  it('ГРАНИЦА: прочитанный таймер называется своим сроком', () => {
    const ms = 7 * 24 * 60 * 60 * 1000;
    expect(disappear({ ...facts, convUnknown: false, disappearMs: ms })?.value)
      .toBe(formatDisappearLabel(ms));
  });

  it('известный срок важнее незнания: цифру не прячем', () => {
    // convUnknown при известном сроке не возникает, но если возникнет —
    // говорить надо то, что знаем. Здесь незнание побеждает намеренно: срок
    // при непрочитанной строке взяться неоткуда, и старое значение было бы
    // от прошлого собеседника.
    expect(disappear({ ...facts, convUnknown: true, disappearMs: 60_000 })?.value)
      .toBe('не удалось прочитать');
  });

  it('три исхода названы тремя разными словами', () => {
    const vals = [
      disappear({ ...facts, convUnknown: false, disappearMs: null })?.value,
      disappear({ ...facts, convUnknown: true, disappearMs: null })?.value,
      disappear({ ...facts, convUnknown: false, disappearMs: 60_000 })?.value,
    ];
    expect(new Set(vals).size).toBe(3);
  });

  it('подпись — та же, что в меню переписки (v4.32.1047)', () => {
    expect(read('ui', 'screens', 'ChatScreen.tsx')).toContain('не удалось прочитать');
  });

  it('остальные пункты настроек незнанием не задеты', () => {
    const known = hubSettings({ ...facts, convUnknown: false }).map((i) => i.id);
    const unknown = hubSettings({ ...facts, convUnknown: true }).map((i) => i.id);
    expect(unknown).toEqual(known);
  });
});

describe('карточка читает различающим чтением', () => {
  it('зовёт listConversationsRead и отличает null от пустоты', () => {
    const body = slice(PEEK(), 'const convs = await listConversationsRead', 'const [guard, wasReported]');
    expect(body).toContain('if (convs === null) {');
    expect(body).toContain('setConvUnknown(true);');
    expect(body).toContain('setConvUnknown(false);');
    expect(body).toContain("convs.find((c) => c.contactPubB64 === pub)");
  });

  it('отказ теперь виден в журнале, а не гаснет внутри обёртки', () => {
    const body = slice(PEEK(), 'const convs = await listConversationsRead', 'const [guard, wasReported]');
    expect(body).toContain("log.warn('ui_peek_conv_read_failed'");
  });

  it('двузначная listConversations из карточки ушла совсем', () => {
    expect(PEEK()).not.toContain('await listConversations(');
    expect(PEEK()).toContain('listConversationsRead,');
  });

  it('отметка сбрасывается на смену собеседника', () => {
    const body = slice(PEEK(), 'setDisappearMs(null);', 'setWallpaper(null);');
    expect(body).toContain('setConvUnknown(false);');
  });

  it('признак доезжает до фактов карточки и до списка зависимостей', () => {
    const body = slice(PEEK(), 'const facts: HubFacts = useMemo', 'const quickActions');
    expect(body).toContain('convUnknown,');
    expect(body).toContain('disappearMs, convUnknown, reported');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: пустой срок форматтер называет словом «Выкл»', () => {
    // Это и есть механизм лжи: незнание приходило в карточку как `null`, а
    // `null` у форматтера — выключенный таймер.
    expect(formatDisappearLabel(null)).toBe('Выкл');
  });

  it('ПОВОД ЖИВ: обёртка списка разговоров по-прежнему сводит отказ к пустоте', () => {
    const body = slice(read('core', 'storage', 'local.ts'),
      'export async function listConversations(', 'export async function listConversationsRead');
    expect(body).toContain('?? []');
  });

  it('ЗАКРЕПКА: поле в HubFacts обязательное, забыть его нельзя', () => {
    const decl = slice(read('ui', 'components', 'profileHubModel.ts'), 'export type HubFacts = {', 'export function');
    expect(decl).toContain('convUnknown: boolean;');
    expect(decl).not.toContain('convUnknown?: boolean;');
  });

  it('ЗАКРЕПКА: пункт автоудаления в настройках один и он у переписки', () => {
    expect(hubSettings(facts).filter((i) => i.id === 'disappear')).toHaveLength(1);
  });

  it('ГРАНИЦА: кнопка звука называет действие, а не состояние, и её не трогали', () => {
    const model = read('ui', 'components', 'profileHubModel.ts');
    expect(model).toContain("out.push({ id: 'mute', label: f.muted ? 'Со звуком' : 'Без звука' });");
  });
});
