/**
 * v4.32.865. Пачка выделенных сообщений: один отказ отменял всё остальное.
 *
 * Дефект. Четыре действия над выделением — удалить и «звезда» в переписке,
 * удалить и «звезда» в группе — раскладывались в `Promise.all`. Это обещание
 * отклоняется на первом же отказе, а `runGuardedOp` ловит его снаружи: весь
 * остаток обработчика не выполняется вовсе. Остальные записи при этом
 * доходят до базы — `Promise.all` не отменяет начатое, — и получается
 * расхождение: в базе новое, на экране прежнее.
 *
 * Цена. Выделение не снимается, список не перечитывается. Человек видит, что
 * не произошло ничего, а при следующем открытии переписки звёзды стоят и
 * сообщения исчезли — «само». В группе хуже: сообщения, удалённые здесь, не
 * объявлены участникам, и у них они остаются навсегда; рассылка стояла в том
 * же остатке, что и перерисовка.
 *
 * Правка. `allSettled` вместо `all` — так же, как у архивации прочитанных
 * (v4.32.838). Выделение снимается и список перечитывается всегда, отказавшие
 * считаются, и об их числе говорят словом: «ни одно» и «одно из сорока» —
 * разные новости. Участникам группы объявляются ровно те сообщения, которые
 * действительно удалились здесь.
 *
 * Проверяется исходник: оба экрана в jest не поднимаются, а вся суть правки —
 * в том, какая запись стоит в обработчике и что стоит после неё.
 */
import * as fs from 'fs';
import * as path from 'path';

const SCREENS = __dirname.replace(/__tests__$/, '');
const read = (name: string): string => fs.readFileSync(path.join(SCREENS, name), 'utf8');

/** Код без комментариев: пояснение не должно подменять проверку. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const CHAT = (): string => codeOnly(read('ChatScreen.tsx'));
const GROUPS = (): string => codeOnly(read('GroupsScreen.tsx'));
const GUARD = (): string => fs.readFileSync(path.join(SCREENS, '..', 'components', 'runGuardedOp.ts'), 'utf8');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/**
 * Тело одного runGuardedOp — от его открытия до закрывающей метки журнала.
 * Якорь — метка, а не подпись отказа: подписи повторяются (у одиночной
 * звезды и у пачки она одна и та же), и поиск по ней приводил в чужой
 * обработчик. Метка у каждого своя.
 */
function handler(src: string, tag: string): string {
  const end = src.indexOf(`'${tag}'`);
  expect(end).toBeGreaterThan(0);
  expect(src.indexOf(`'${tag}'`, end + 1)).toBe(-1);
  const start = src.lastIndexOf('runGuardedOp(', end);
  expect(start).toBeGreaterThan(0);
  return src.slice(start, end);
}

/** Четыре обработчика, каждый — своя пачка выделенных сообщений. */
const HANDLERS = (): Record<string, string> => ({
  'переписка: удалить': handler(CHAT(), 'ui_chat_delete_selected_failed'),
  'переписка: звезда': handler(CHAT(), 'ui_chat_star_selected_failed'),
  'группа: удалить': handler(GROUPS(), 'ui_group_delete_selected_failed'),
  'группа: звезда': handler(GROUPS(), 'ui_group_star_selected_failed'),
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('все четыре действия над выделением на месте', () => {
    // На коде до правки этот блок падает — и это не вакуумность, а сама
    // находка: у звезды в группе метки для журнала не было вовсе, отказ
    // некуда было записать. Три остальных якоря старше правки.
    const handlers = HANDLERS();
    expect(Object.keys(handlers)).toHaveLength(4);
    for (const body of Object.values(handlers)) expect(body.length).toBeGreaterThan(40);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('отказ по-прежнему ловится снаружи: один try на всё действие', () => {
    const guard = GUARD();
    expect(guard).toContain('await op();');
    expect(guard.split('catch (e) {').length - 1).toBe(1);
    // И это записано намеренно: «всё, что после, кладите внутрь».
    expect(guard).toContain('кладите внутрь');
  });

  it('`Promise.all` действительно отклоняется первым отказом — сам по себе он не считает', async () => {
    const res: string[] = [];
    await Promise.all([
      Promise.resolve().then(() => void res.push('a')),
      Promise.reject(new Error('нет')),
      Promise.resolve().then(() => void res.push('b')),
    ]).catch(() => void res.push('поймали'));
    // Соседи доработали — но обработчик до своего остатка не дошёл.
    expect(res).toContain('a');
    expect(res).toContain('поймали');
  });

  it('образец уже есть: архивация прочитанных считает отказавшие', () => {
    const list = fs.readFileSync(path.join(SCREENS, 'ChatListScreen.tsx'), 'utf8');
    expect(list).toContain('await Promise.allSettled(');
    expect(list).toContain("r.status === 'rejected'");
  });
});

describe('один отказ не отменяет остальное', () => {
  it('пачку раскладывают в Promise.all только над формой, которая не бросает', () => {
    // Правило структурное: `Promise.all(что-то.map(…))` отклоняется первым же
    // отказом. Оно допустимо ровно тогда, когда вызванная форма отвечает
    // исходом, а не исключением, — имя такой формы кончается на Checked.
    // Совместную загрузку (`Promise.all([a(), b()])`) правило не трогает.
    const RISKY = /Promise\.all\(\s*[A-Za-z_$][A-Za-z0-9_$.]*\.map\(/g;
    for (const src of [CHAT(), GROUPS()]) {
      const spots = [...src.matchAll(RISKY)].map((m) => m.index ?? 0);
      for (const at of spots) expect(src.slice(at, at + 160)).toMatch(/\w+Checked\(/);
    }
  });

  it('каждая пачка ждёт всех и считает отказавшие', () => {
    for (const [name, body] of Object.entries(HANDLERS())) {
      // Либо ждём всех через allSettled, либо зовём форму, отвечающую словом.
      expect([name, /Promise\.allSettled\(|\w+Checked\(/.test(body)]).toEqual([name, true]);
      expect([name, /=== 'rejected'|=== 'failed'/.test(body)]).toEqual([name, true]);
    }
  });

  it('выделение снимается и список перечитывается ДО того, как отказ поднимут', () => {
    const chat = HANDLERS();
    for (const [name, body] of Object.entries(chat)) {
      const thrown = body.indexOf('throw new Error(');
      const clearedAt = Math.max(body.indexOf('setSelectedIds(new Set());'), body.indexOf('setSelectedGrpIds(new Set());'));
      const reloadAt = Math.max(body.indexOf('appendNewMessages();'), body.indexOf('loadMessages();'));
      expect([name, clearedAt > 0]).toEqual([name, true]);
      expect([name, reloadAt > 0]).toEqual([name, true]);
      if (thrown > 0) {
        expect([name, clearedAt < thrown]).toEqual([name, true]);
        expect([name, reloadAt < thrown]).toEqual([name, true]);
      }
    }
  });

  it('об отказавших говорят числом, а не общей фразой', () => {
    expect(CHAT()).toContain('`Не удалось изменить избранное: ${failed} из ${msgs.length}`');
    expect(GROUPS()).toContain('`Не удалось добавить в избранное: ${failed} из ${ids.length}`');
    expect(GROUPS()).toContain("pluralRu(failed, 'сообщение осталось', 'сообщения остались', 'сообщений остались')");
  });

  it('удаление в переписке считает и брошенное, и вернувшееся «не вышло»', () => {
    expect(HANDLERS()['переписка: удалить']).toContain(
      "outcomes.filter((o) => o.status === 'rejected' || o.value === 'failed').length",
    );
  });
});

describe('группа не расходится с участниками', () => {
  it('объявляются ровно те сообщения, что удалились здесь', () => {
    const body = HANDLERS()['группа: удалить'];
    const forEach = body.indexOf('ids.forEach((id, i) => {');
    expect(forEach).toBeGreaterThan(0);
    expect(body.slice(forEach, forEach + 260)).toContain("if (res[i] === 'failed') return;");
    expect(body.slice(forEach, forEach + 260)).toContain("op: 'del', msgId: id");
    // Рассылка стоит до подъёма отказа — иначе она снова оказалась бы в
    // остатке, который не выполняется.
    expect(forEach).toBeLessThan(body.indexOf('throw new Error('));
  });

  it('успех «Добавлено в избранное» больше не показывают поверх отказа', () => {
    const body = HANDLERS()['группа: звезда'];
    expect(body.indexOf('throw new Error(')).toBeLessThan(body.indexOf("showSuccess('Добавлено в избранное')"));
  });

  it('у звезды в группе появилась метка для журнала — отказ можно найти потом', () => {
    expect(GROUPS()).toContain("'ui_group_star_selected_failed'");
  });

  it('удаление одного сообщения тоже читает исход, а не зовёт вслепую', () => {
    const body = handler(GROUPS(), 'group_msg_delete_failed');
    expect(body).toContain('const write = await deleteGroupMessageChecked(msg.id, pid);');
    expect(body).toContain("if (write !== 'failed') {");
    expect(body).toContain("if (write === 'failed') throw new Error(");
    // Объявление участникам стоит под этим условием, а не рядом с ним.
    const cond = body.indexOf("if (write !== 'failed') {");
    expect(body.slice(cond, cond + 240)).toContain("op: 'del', msgId: msg.id");
  });

  it('формы, которая гасит отказ и отвечает void, больше нет вовсе', () => {
    const local = fs.readFileSync(
      path.join(SCREENS, '..', '..', 'core', 'storage', 'local.ts'),
      'utf8',
    );
    expect(local).not.toContain('export async function deleteGroupMessage(');
    expect(local).toContain('export async function deleteGroupMessageChecked(');
    for (const src of [CHAT(), GROUPS()]) expect(src).not.toMatch(/\bdeleteGroupMessage\(/);
  });
});
