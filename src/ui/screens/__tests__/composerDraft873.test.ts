/**
 * v4.32.873. Черновик не следовал за полем ввода.
 *
 * Дефект. Черновик писало ровно одно место на экран — обработчик набора с
 * клавиатуры (`onChangeText` в переписке, `handleTextChange` в группе). Всё
 * остальное, что кладёт текст в поле, шло мимо: смайл из панели, разметка из
 * полоски, подсказка смайла, подставленная команда, упоминание, хэштег,
 * быстрый ответ, восстановленный «недавно удалённый» — и, дороже всего, текст,
 * возвращённый в поле после отказа отправки. Обратная сторона та же: отправка
 * очищала поле `setMsg('')`/`setText('')`, не трогая ни отложенную запись, ни
 * сам черновик.
 *
 * Цена. В одну сторону — тихая потеря: поле выглядит заполненным, а в базе
 * пусто, и достаточно выйти из переписки, чтобы написанное пропало совсем.
 * Хуже всего с возвратом после отказа: отправка уже сняла черновик, человек
 * видит свой текст на экране и уходит за подсказкой — вернувшись, не находит
 * ничего. В другую сторону — воскрешение: подпись к снимкам берётся из поля
 * ввода (`setImageCaption(msg.trim())`), поле очищалось, черновик оставался, и
 * отправленная подпись возвращалась в поле при следующем открытии — человек
 * отправлял её вторым сообщением.
 *
 * Правка. На каждом экране появилась пара: `putComposer`/`takeComposer` в
 * переписке и `putGroupText`/`takeGroupText` в группе. Первая кладёт текст в
 * поле вместе с отложенной записью черновика, вторая опустошает поле вместе с
 * черновиком и таймером. Голый `setMsg`/`setText` остался только там, где
 * черновику двигаться не положено: восстановление при входе, начало и отмена
 * правки, тела самих помощников и путь с клавиатуры.
 */
import fs from 'fs';
import path from 'path';

const SCREENS = __dirname.replace(/__tests__$/, '');
const read = (name: string): string => fs.readFileSync(path.join(SCREENS, name), 'utf8');

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

type Screen = {
  file: string;
  /** Голый установщик состояния поля ввода. */
  setter: string;
  put: string;
  take: string;
  save: string;
  clear: string;
  /** Единственная запись черновика в базу. */
  store: string;
  ref: string;
  media: string;
  mediaStop: string;
};

const SCREEN_LIST: Record<string, Screen> = {
  'переписка': {
    file: 'ChatScreen.tsx',
    setter: 'setMsg',
    put: 'putComposer',
    take: 'takeComposer',
    save: 'saveDraft',
    clear: 'clearDraft',
    store: 'setConversationDraft(',
    ref: 'msgRef.current',
    media: 'const sendWithMedia = async (',
    mediaStop: '\n  };',
  },
  'группа': {
    file: 'GroupsScreen.tsx',
    setter: 'setText',
    put: 'putGroupText',
    take: 'takeGroupText',
    save: 'saveGroupDraft',
    clear: 'clearGroupDraft',
    store: 'setGroupDraft(',
    ref: 'textRef.current',
    media: 'const sendGroupImages = useCallback(',
    mediaStop: '\n  }, [',
  },
};

const SRC = (s: Screen): string => codeOnly(read(s.file));

/** Строки с голым установщиком поля — вместе с окном соседей ±2. */
function rawSites(s: Screen): Array<{ line: string; window: string }> {
  const lines = SRC(s).split('\n');
  const out: Array<{ line: string; window: string }> = [];
  lines.forEach((line, i) => {
    if (!line.includes(`${s.setter}(`)) return;
    out.push({ line: line.trim(), window: lines.slice(Math.max(0, i - 2), i + 3).join('\n') });
  });
  return out;
}

/** Тело функции от её объявления до закрывающей строки того же отступа. */
function bodyAfter(src: string, anchor: string, stop = '\n  }'): string {
  const at = src.indexOf(anchor);
  expect(at).toBeGreaterThan(0);
  expect(src.indexOf(anchor, at + 1)).toBe(-1);
  const end = src.indexOf(stop, at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('оба экрана на месте и поле ввода у каждого своё', () => {
    for (const [name, s] of Object.entries(SCREEN_LIST)) {
      const src = SRC(s);
      expect([name, src.length > 50000]).toEqual([name, true]);
      expect([name, src.includes(`${s.setter}(`)]).toEqual([name, true]);
      expect([name, src.includes(s.ref)]).toEqual([name, true]);
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('черновик по-прежнему уходит в базу ровно из одного места', () => {
    for (const [name, s] of Object.entries(SCREEN_LIST)) {
      const src = SRC(s);
      expect([name, src.split(s.store).length - 1]).toEqual([name, 1]);
    }
  });

  it('отправляется то, что в ref, — поле, заполненное мимо него, не уходит', () => {
    for (const [name, s] of Object.entries(SCREEN_LIST)) {
      expect([name, SRC(s).includes(s.ref)]).toEqual([name, true]);
    }
  });

  it('запись черновика отложена — поле и база расходятся по построению', () => {
    // Оттого голый `setMsg`/`setText` и опасен в обе стороны: положенный в
    // поле текст сам в базу не попадёт, а стёртый — не исчезнет из неё.
    for (const [name, s] of Object.entries(SCREEN_LIST)) {
      expect([name, SRC(s).includes('draftSaveRef.current = setTimeout(')]).toEqual([name, true]);
    }
  });
});

describe('черновик следует за полем ввода', () => {
  it('голый установщик остался только там, где черновику двигаться не положено', () => {
    for (const [name, s] of Object.entries(SCREEN_LIST)) {
      const bad = rawSites(s).filter(({ window }) => !(
        // восстановление при входе — в базе уже лежит то же самое
        window.includes('draftText')
        // начало и отмена правки: поле следует за сообщением, а черновик —
        // тот, что человек писал до правки, и затирать его нечем
        || window.includes('setEditTarget(') || window.includes('setEditingMsg(')
        // тела самих помощников и путь с клавиатуры
        || window.includes(`${s.save}(`) || window.includes(`${s.clear}();`)
      )).map(({ line }) => line);
      expect([name, bad]).toEqual([name, []]);
    }
  });

  it('проверка выше не пустая: разрешённые места и правда есть', () => {
    for (const [name, s] of Object.entries(SCREEN_LIST)) {
      expect([name, rawSites(s).length >= 4]).toEqual([name, true]);
    }
  });

  it('положить текст в поле — значит записать черновик', () => {
    for (const [name, s] of Object.entries(SCREEN_LIST)) {
      const body = bodyAfter(SRC(s), `const ${s.put} = useCallback(`);
      expect([name, body]).toEqual([name, expect.stringContaining(`${s.save}(next)`)]);
      expect([name, body]).toEqual([name, expect.stringContaining(`${s.ref} = next;`)]);
    }
  });

  it('опустошить поле — значит снять черновик вместе с отложенной записью', () => {
    for (const [name, s] of Object.entries(SCREEN_LIST)) {
      const body = bodyAfter(SRC(s), `const ${s.take} = useCallback(`);
      expect([name, body]).toEqual([name, expect.stringContaining(`${s.clear}();`)]);
      expect([name, body]).toEqual([name, expect.stringContaining(`${s.ref} = '';`)]);
    }
  });

  it('текст, возвращённый в поле после отказа, снова становится черновиком', () => {
    // Отправка снимает черновик до ответа сети. Если ответ — отказ, текст
    // кладётся обратно только помощником, иначе он живёт лишь на экране.
    const chat = SRC(SCREEN_LIST['переписка']);
    expect(chat.split('putComposer(text);').length - 1).toBeGreaterThanOrEqual(5);
    const groups = SRC(SCREEN_LIST['группа']);
    expect(groups).toContain('putGroupText(t);');
  });

  it('подпись к снимкам уходит из поля вместе с черновиком', () => {
    for (const [name, s] of Object.entries(SCREEN_LIST)) {
      const src = SRC(s);
      expect([name, bodyAfter(src, s.media, s.mediaStop)]).toEqual([
        name,
        expect.stringContaining(`${s.take}();`),
      ]);
      // И прежней половинчатой очистки в предпросмотре больше нет.
      expect([name, src.includes(`if (caption) ${s.setter}('');`)]).toEqual([name, false]);
    }
  });
});
