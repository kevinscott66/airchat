/**
 * Удаление у себя отвечает, получилось ли (v4.32.805).
 *
 * Дефект. `deleteMessageLocally` — единственный путь удаления, у которого
 * ответа не было вовсе. `deleteChatMessage` отдаёт булев с v4.32.555, а
 * `deleteChatMessageChecked` три слова с v4.32.771; обёртка в messaging
 * выбрасывала и то и другое, возвращая `void`.
 *
 * Цена. Три места верили ей на слово. «Удалить у себя» показывало «Сообщение
 * удалено» независимо от того, ушла ли строка. «Удалить» на пачке снимало
 * отметку выбора и перечитывало список — сообщения возвращались на место без
 * единого слова. Хуже всего с одноразовым снимком: порядок `runViewOnceTap`
 * ловил отказ через `.catch`, а бросать было некому — удаление гасило свой
 * отказ само, — так что показанный «одноразовый» кадр при занятой базе молча
 * оставался в переписке читаемым навсегда. Тот самый случай, ради которого
 * `onRemoveFailed` и написан: ветка была мёртвой с рождения.
 *
 * Правка. Обёртка отдаёт исход целиком. `runViewOnceTap` ждёт от `remove`
 * булев «строки в базе нет» и зовёт `onRemoveFailed` по ответу, а не по
 * исключению; `catch` остался вторым рубежом. «Ни одной строки не подошло» —
 * не отказ: её либо уже стёрли, либо не было, и снимка в переписке нет в обоих
 * случаях. Слова тоже другие: человеку важно не то, что сорвалась запись, а
 * то, что одноразовое фото никуда не делось.
 */
import fs from 'fs';
import path from 'path';

import { runViewOnceTap, type ViewOnceTapDeps } from '../chat-utils/viewOnceTap';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const CHAT = codeOnly(read('ui', 'screens', 'ChatScreen.tsx'));
const GROUPS = codeOnly(read('ui', 'screens', 'GroupsScreen.tsx'));
const MESSAGING = codeOnly(read('core', 'social', 'messaging.ts'));
const TAP = codeOnly(read('ui', 'screens', 'chat-utils', 'viewOnceTap.ts'));

/** Стенд: отложенное держим в руках, чтобы проверить, что будет после. */
function stand(over: Partial<ViewOnceTapDeps> = {}) {
  const pending: Array<() => void> = [];
  const deps: ViewOnceTapDeps = {
    resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 0 })),
    alive: jest.fn(() => true),
    open: jest.fn(),
    later: jest.fn((fn: () => void) => { pending.push(fn); }),
    remove: jest.fn(async () => true),
    // v4.32.828: запись «показан, подлежит удалению» и её снятие.
    note: jest.fn(async () => true),
    forget: jest.fn(async () => undefined),
    reload: jest.fn(),
    onUnavailable: jest.fn(),
    onRemoveFailed: jest.fn(),
    ...over,
  };
  return {
    deps,
    async elapse() {
      pending.splice(0, pending.length).forEach((fn) => fn());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('отказ удаления виден по ответу, а не по исключению', () => {
  it('строка осталась — человеку сказано, и список перечитан', async () => {
    const s = stand({ remove: jest.fn(async () => false) });
    await runViewOnceTap(s.deps);
    await s.elapse();
    expect(s.deps.onRemoveFailed).toHaveBeenCalledTimes(1);
    // Перечитать нужно как раз потому, что строка на месте: пусть человек
    // видит снимок в переписке, а не верит на слово, что тот сгорел.
    expect(s.deps.reload).toHaveBeenCalledTimes(1);
  });

  it('строка ушла — молчим и перечитываем', async () => {
    const s = stand();
    await runViewOnceTap(s.deps);
    await s.elapse();
    expect(s.deps.onRemoveFailed).not.toHaveBeenCalled();
    expect(s.deps.reload).toHaveBeenCalledTimes(1);
  });

  it('брошенное исключение всё ещё ловится — это второй рубеж, не первый', async () => {
    const s = stand({ remove: jest.fn(async () => { throw new Error('база занята'); }) });
    await runViewOnceTap(s.deps);
    await s.elapse();
    expect(s.deps.onRemoveFailed).toHaveBeenCalledTimes(1);
  });

  it('ушли с экрана — сказать некому, но список не трогаем', async () => {
    let living = true;
    const s = stand({ alive: jest.fn(() => living), remove: jest.fn(async () => { living = false; return false; }) });
    await runViewOnceTap(s.deps);
    await s.elapse();
    expect(s.deps.onRemoveFailed).toHaveBeenCalledTimes(1);
    expect(s.deps.reload).not.toHaveBeenCalled();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежний порядок цел', () => {
  it('показали не всё — не удаляем ничего', async () => {
    const s = stand({ resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 1 })) });
    await runViewOnceTap(s.deps);
    expect(s.deps.later).not.toHaveBeenCalled();
    expect(s.deps.remove).not.toHaveBeenCalled();
  });

  it('удаление по-прежнему отложенное, а не сразу после показа', async () => {
    const s = stand();
    await runViewOnceTap(s.deps);
    expect(s.deps.open).toHaveBeenCalled();
    expect(s.deps.remove).not.toHaveBeenCalled();
    await s.elapse();
    expect(s.deps.remove).toHaveBeenCalledTimes(1);
  });

  it('нечего показывать — удаления нет и речи', async () => {
    const s = stand({ resolve: jest.fn(async () => ({ uris: [], missing: 0 })) });
    await runViewOnceTap(s.deps);
    expect(s.deps.onUnavailable).toHaveBeenCalled();
    expect(s.deps.later).not.toHaveBeenCalled();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('база отказывает молча: свой сбой удаление гасит само', () => {
    const body = codeOnly(read('core', 'storage', 'local.ts'));
    // Отсюда и «отказ не бросается»: наружу уходит слово, а не исключение.
    expect(body).toContain("export type ChatDeleteWrite = 'deleted' | 'missing' | 'failed';");
    expect(body).toContain("export type GroupDeleteWrite = 'deleted' | 'missing' | 'failed';");
    expect(body).toContain("log.warn('chat_message_delete_failed'");
  });

  it('снимок сгорает только удалением строки — другого выключателя нет', () => {
    // В chat_messages нет столбца «показано»: пока строка цела, снимок
    // открывается снова. Поэтому неудача удаления — это не мелкая помарка.
    const body = codeOnly(read('core', 'storage', 'local.ts'));
    const a = body.indexOf('CREATE TABLE IF NOT EXISTS chat_messages');
    expect(a).toBeGreaterThan(-1);
    const schema = body.slice(a, body.indexOf(')', body.indexOf('media_cids', a)));
    expect(schema).not.toContain('view_once');
    expect(schema).not.toContain('viewed');
  });
});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('обёртка удаления отдаёт исход, а не void', () => {
    expect(MESSAGING).toContain('async deleteMessageLocalOnly(messageId: string): Promise<ChatDeleteWrite> {');
    expect(MESSAGING).toContain('return deleteChatMessageChecked(messageId, await this.ownerProfileId());');
    expect(MESSAGING).toContain('deleteMessageLocally(messageId: string): Promise<ChatDeleteWrite> {');
  });

  it('порядок ждёт булев, а не пустоту', () => {
    expect(TAP).toContain('remove: () => Promise<boolean>;');
    // v4.32.828: та же развилка, но удачное удаление теперь ещё и снимает
    // запись с полки, так что «если не вышло» стало «иначе».
    expect(TAP).toContain('if (gone) void deps.forget();');
    expect(TAP).toContain('else deps.onRemoveFailed();');
  });

  it('оба экрана считают «строки нет» удачей, а отказ — нет', () => {
    expect(CHAT).toContain("return (await svc.deleteMessageLocally(row.id)) !== 'failed';");
    // v4.32.951: тело закрытия стало составным — удачное удаление теперь ещё
    // и снимает отметку «не ушло». Предмет проверки прежний: удачей считается
    // всё, кроме отказа, и «строки нет» остаётся удачей.
    expect(GROUPS).toContain("const gone = (await deleteGroupMessageChecked(item.id, pid)) !== 'failed';");
    expect(GROUPS).toContain('return gone;');
  });

  it('«Удалить у себя» перестало обещать за базу', () => {
    expect(CHAT).toContain('const outcome = await svc2.deleteMessageLocally(q.id);');
    expect(CHAT).toContain("if (outcome === 'failed') showError('Не удалось удалить — сообщение осталось в переписке');");
  });

  it('удаление пачки считает оставшиеся', () => {
    // v4.32.865: ждём всех — брошенное исключение одной строки отменяло
    // остаток обработчика вместе с этим самым отчётом.
    expect(CHAT).toContain('const outcomes = await Promise.allSettled(ids.map((id) => svc.deleteMessageLocally(id)));');
    expect(CHAT).toContain(
      "const stuck = outcomes.filter((o) => o.status === 'rejected' || o.value === 'failed').length;",
    );
    // Окончание считает общее правило, а не четвёртая копия на месте.
    expect(CHAT).toContain('pluralRu(stuck,');
  });
});
