/**
 * Правка на полке отложенных: ячейка принадлежит автору (v4.32.673).
 *
 * Полка отложенных событий держит по одной записи на ячейку, и при совпадении
 * ячеек побеждает та, у которой время больше, — остальные не просто уходят
 * вниз, а не попадают на полку вовсе. У правки ячейка была голой строкой
 * 'edit', одной на всю публикацию, и это единственный род события, который не
 * различал отправителей: у реакции и голоса в ячейке стоит DID, у комментария
 * — его номер.
 *
 * Чем это оборачивалось. Авторство правки на полке проверить нечем: публикации
 * ещё нет, а её автора знает только она сама. Проверка стоит на выходе —
 * applyFeedEnvelope отвергает правку с чужим DID, — но до выхода доживал один
 * жилец ячейки. Любой контакт, подписав feed_edit на ещё не доехавшую до
 * получателя публикацию временем чуть вперёд (транспорт разрешает пять минут
 * от текущего), занимал ячейку, вытеснял из неё настоящую правку автора и сам
 * отсеивался при применении. Правка автора пропадала молча и навсегда:
 * очереди повторов у неё нет.
 *
 * Сторож смотрит на поведение полки, а не на её текст: модуль feedDeferred
 * импортируется в jest без единой заглушки — из внешнего у него только тип.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  addDeferred,
  deferredSlot,
  takeDeferred,
  type DeferredEvent,
  type DeferredStore,
} from '../feedDeferred';

const T0 = 1_700_000_000_000;

function edit(authorDid: string, ts: number, newText: string): DeferredEvent {
  return { type: 'feed_edit', authorDid, ts, data: { newText } };
}

function texts(s: DeferredStore, postId: string): string[] {
  return takeDeferred(s, postId, T0)
    .events.map((e) => (e.data as { newText: string }).newText);
}

/** Исходник без строк-комментариев: докблоки цитируют сам разбираемый дефект. */
function codeOnly(src: string): string {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

const SERVICE = codeOnly(readFileSync(join(__dirname, '..', 'feedService.ts'), 'utf8'));
const TRANSPORT = codeOnly(readFileSync(join(__dirname, '..', 'feedTransport.ts'), 'utf8'));

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('совпадение ячеек по-прежнему не пускает на полку событие постарше', () => {
    // Тот же автор — та же ячейка: механизм вытеснения на месте, иначе
    // сторож ниже проверял бы пустоту.
    let s: DeferredStore = {};
    s = addDeferred(s, 'p1', edit('did:key:zA', T0 + 500, 'свежая'), T0);
    s = addDeferred(s, 'p1', edit('did:key:zA', T0 + 10, 'устаревшая'), T0);
    expect(texts(s, 'p1')).toEqual(['свежая']);
  });

  it('правка чужого автора отсеивается только на выходе, когда полка уже разобрана', () => {
    expect(SERVICE).toMatch(/existing\.authorDid !== payload\.authorDid/);
    expect(SERVICE).toMatch(/log\.warn\('feed_edit_auth_mismatch'/);
    // ...а до выхода она обязана была куда-то лечь: правка без публикации
    // откладывается, а не отбрасывается.
    expect(SERVICE).toMatch(/await deferFeedEvent\(payload, envelopePid\);\n\s*log\.info\('feed_edit_unknown_post'/);
  });

  it('время в конверте разрешено уводить вперёд — это и есть бюджет занявшего ячейку', () => {
    expect(TRANSPORT).toMatch(/payload\.ts = Math\.min\(Math\.max\(payload\.ts, 0\), Date\.now\(\) \+ 5 \* 60_000\);/);
  });
});

describe('ячейка правки принадлежит автору', () => {
  it('правки разных отправителей не вытесняют друг друга', () => {
    let s: DeferredStore = {};
    // Чужой конверт временем на пять минут вперёд — предел, который разрешает
    // транспорт.
    s = addDeferred(s, 'p1', edit('did:key:zЧужой', T0 + 5 * 60_000, 'подделка'), T0);
    const before = texts(s, 'p1');
    s = addDeferred(s, 'p1', edit('did:key:zАвтор', T0 + 1000, 'настоящая'), T0);
    const after = texts(s, 'p1');
    expect(before).toEqual(['подделка']);
    expect(after.length - before.length).toBe(1);
    expect(after).toContain('настоящая');
  });

  it('ячейка называет автора и отличается у разных авторов', () => {
    expect(deferredSlot(edit('did:key:zA', T0, 'x'))).toBe('e|did:key:zA');
    expect(deferredSlot(edit('did:key:zA', T0, 'x'))).toBe(deferredSlot(edit('did:key:zA', T0 + 9, 'y')));
    expect(deferredSlot(edit('did:key:zA', T0, 'x'))).not.toBe(deferredSlot(edit('did:key:zB', T0, 'x')));
  });

  it('ни один род события больше не делит ячейку со всеми подряд', () => {
    const kinds: DeferredEvent[] = [
      edit('did:key:zA', T0, 'x'),
      { type: 'feed_reaction', authorDid: 'did:key:zA', ts: T0, data: { emoji: '👍' } },
      { type: 'feed_poll_vote', authorDid: 'did:key:zA', ts: T0, data: { optionIndex: 0 } },
      { type: 'feed_comment', authorDid: 'did:key:zA', ts: T0, data: { commentId: 'c1' } },
    ];
    for (const e of kinds) {
      const mine = deferredSlot(e);
      const theirs = deferredSlot({ ...e, authorDid: 'did:key:zB' });
      // Комментарий различается своим номером, а не автором: два разных
      // человека физически не выдадут один и тот же commentId.
      if (e.type === 'feed_comment') expect(mine).toBe(theirs);
      else expect(mine).not.toBe(theirs);
    }
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники прочитаны целиком', () => {
    expect(SERVICE.length).toBeGreaterThan(100_000);
    expect(TRANSPORT.length).toBeGreaterThan(10_000);
  });

  it('полка действительно хранит и отдаёт правки', () => {
    const s = addDeferred({}, 'p1', edit('did:key:zA', T0, 'единственная'), T0);
    expect(texts(s, 'p1')).toEqual(['единственная']);
  });
});
