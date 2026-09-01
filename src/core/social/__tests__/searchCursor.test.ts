import fs from 'fs';
import path from 'path';
import {
  anchorStillPresent,
  clampHitIndex,
  hitIndexForAnchor,
  hitLabel,
  hitSetKey,
  stepHitIndex,
} from '../searchCursor';

const SRC = path.join(__dirname, '..', '..', '..');

describe('clampHitIndex', () => {
  test('номер внутри границ остаётся собой', () => {
    expect(clampHitIndex(0, 5)).toBe(0);
    expect(clampHitIndex(4, 5)).toBe(4);
  });

  test('номер за верхней границей заворачивается', () => {
    expect(clampHitIndex(5, 5)).toBe(0);
    expect(clampHitIndex(7, 5)).toBe(2);
  });

  test('отрицательный номер заворачивается в конец, а не даёт -1', () => {
    expect(clampHitIndex(-1, 5)).toBe(4);
    expect(clampHitIndex(-6, 5)).toBe(4);
  });

  test('пустой набор — всегда ноль', () => {
    expect(clampHitIndex(3, 0)).toBe(0);
    expect(clampHitIndex(-3, 0)).toBe(0);
  });

  test('мусорные числа не выносят наружу NaN', () => {
    expect(clampHitIndex(Number.NaN, 5)).toBe(0);
    expect(clampHitIndex(2, Number.NaN)).toBe(0);
    expect(clampHitIndex(Number.POSITIVE_INFINITY, 5)).toBe(0);
    expect(clampHitIndex(1.7, 5)).toBe(1);
  });
});

describe('stepHitIndex', () => {
  test('шаг вперёд по кольцу', () => {
    expect(stepHitIndex(0, 3, 1)).toBe(1);
    expect(stepHitIndex(2, 3, 1)).toBe(0);
  });

  test('шаг назад по кольцу', () => {
    expect(stepHitIndex(0, 3, -1)).toBe(2);
    expect(stepHitIndex(2, 3, -1)).toBe(1);
  });

  test('единственное совпадение — обе стрелки стоят на месте', () => {
    expect(stepHitIndex(0, 1, 1)).toBe(0);
    expect(stepHitIndex(0, 1, -1)).toBe(0);
  });

  test('шаг от испорченного номера сперва приводит его к границам', () => {
    expect(stepHitIndex(99, 4, 1)).toBe(0);
    expect(stepHitIndex(-99, 4, 1)).toBe(2);
  });

  test('пустой набор и мусорный шаг безопасны', () => {
    expect(stepHitIndex(0, 0, 1)).toBe(0);
    expect(stepHitIndex(2, 5, Number.NaN)).toBe(2);
  });

  test('круг из N шагов вперёд возвращает на место', () => {
    let i = 3;
    for (let k = 0; k < 7; k++) i = stepHitIndex(i, 7, 1);
    expect(i).toBe(3);
  });
});

describe('hitIndexForAnchor — курсор идёт за сообщением, а не за номером', () => {
  test('якорь на месте — курсор на нём', () => {
    expect(hitIndexForAnchor(['a', 'b', 'c'], 'b')).toBe(1);
  });

  test('пришло новое совпадение сверху — номер вырос, курсор остался на сообщении', () => {
    // Ровно тот дефект: раньше экран держал номер 1 и после вставки нового
    // совпадения показывал уже другое сообщение (а счётчик сбрасывался в 0).
    const before = ['b', 'c'];
    const after = ['new', 'b', 'c'];
    const anchor = before[0];
    expect(hitIndexForAnchor(before, anchor)).toBe(0);
    expect(hitIndexForAnchor(after, anchor)).toBe(1);
  });

  test('якорь исчез — курсор в начало', () => {
    expect(hitIndexForAnchor(['a', 'c'], 'b')).toBe(0);
  });

  test('якоря не было — курсор в начало', () => {
    expect(hitIndexForAnchor(['a', 'b'], null)).toBe(0);
    expect(hitIndexForAnchor(['a', 'b'], '')).toBe(0);
  });

  test('пустой набор — ноль при любом якоре', () => {
    expect(hitIndexForAnchor([], 'a')).toBe(0);
    expect(hitIndexForAnchor([], null)).toBe(0);
  });

  test('повторяющийся идентификатор берётся первым — курсор не скачет', () => {
    expect(hitIndexForAnchor(['a', 'b', 'a'], 'a')).toBe(0);
  });

  test('удаление совпадения выше якоря сдвигает номер, но не сообщение', () => {
    const after = ['b', 'c'];
    expect(hitIndexForAnchor(['a', 'b', 'c'], 'c')).toBe(2);
    expect(hitIndexForAnchor(after, 'c')).toBe(1);
  });
});

describe('anchorStillPresent — прокрутка только при потере места', () => {
  test('якорь среди совпадений — список не дёргаем', () => {
    expect(anchorStillPresent(['a', 'b'], 'a')).toBe(true);
  });

  test('якорь пропал — можно прокручивать', () => {
    expect(anchorStillPresent(['a', 'b'], 'z')).toBe(false);
  });

  test('новый поиск (якоря нет) — прокручиваем к первому совпадению', () => {
    expect(anchorStillPresent(['a', 'b'], null)).toBe(false);
  });

  test('совпадений не осталось — прокручивать некуда', () => {
    expect(anchorStillPresent([], 'a')).toBe(false);
  });

  test('входящее сообщение без совпадения не трогает место', () => {
    const ids = ['m3', 'm7', 'm9'];
    const anchor = 'm7';
    // Список пересобрался (пришло сообщение, не подходящее под запрос),
    // состав совпадений тот же.
    expect(anchorStillPresent(ids, anchor)).toBe(true);
    expect(hitIndexForAnchor(ids, anchor)).toBe(1);
  });
});

describe('hitSetKey — эффект просыпается от состава, а не от нового массива', () => {
  test('пересозданный массив того же состава даёт тот же ключ', () => {
    const a = ['x', 'y'];
    const b = ['x', 'y'];
    expect(a).not.toBe(b);
    expect(hitSetKey(a)).toBe(hitSetKey(b));
  });

  test('изменившийся состав даёт другой ключ', () => {
    expect(hitSetKey(['x', 'y'])).not.toBe(hitSetKey(['x', 'y', 'z']));
    expect(hitSetKey(['x', 'y'])).not.toBe(hitSetKey(['y', 'x']));
  });

  test('пустой набор имеет пустой ключ', () => {
    expect(hitSetKey([])).toBe('');
  });

  test('перестановка не путается с добавлением', () => {
    expect(hitSetKey(['a', 'bc'])).not.toBe(hitSetKey(['ab', 'c']));
  });
});

describe('hitLabel', () => {
  test('человеческая нумерация с единицы', () => {
    expect(hitLabel(0, 12)).toBe('1/12');
    expect(hitLabel(11, 12)).toBe('12/12');
  });

  test('испорченный номер не показывает «0/12» или «13/12»', () => {
    expect(hitLabel(-1, 12)).toBe('12/12');
    expect(hitLabel(12, 12)).toBe('1/12');
    expect(hitLabel(Number.NaN, 12)).toBe('1/12');
  });

  test('пустой набор подписи не имеет', () => {
    expect(hitLabel(0, 0)).toBe('');
    expect(hitLabel(3, -2)).toBe('');
  });
});

describe('форма исходников — v4.32.506', () => {
  const chat = fs.readFileSync(path.join(SRC, 'ui', 'screens', 'ChatScreen.tsx'), 'utf8');
  const groups = fs.readFileSync(path.join(SRC, 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');
  const mod = fs.readFileSync(path.join(SRC, 'core', 'social', 'searchCursor.ts'), 'utf8');

  test('модуль без импортов', () => {
    expect(mod).not.toMatch(/^import\s/m);
    expect(mod).not.toContain('require(');
  });

  test('эффект поиска просыпается от состава набора, а не от массива', () => {
    expect(chat).toContain('}, [searchHitKey]);');
    expect(chat).not.toContain('}, [searchHitIndices]);');
  });

  test('ChatScreen держит якорь и сверяет его при пересборке', () => {
    expect(chat).toContain('const searchAnchorRef = useRef<string | null>(null);');
    expect(chat).toContain('anchorStillPresent(ids, searchAnchorRef.current)');
    expect(chat).toContain('hitIndexForAnchor(ids, searchAnchorRef.current)');
    expect(chat).toContain('if (keep) return;');
  });

  test('якорь сбрасывается при смене запроса и закрытии поиска', () => {
    expect(chat.match(/searchAnchorRef\.current = null;/g)?.length).toBe(3);
  });

  test('стрелки и счётчик считаются одним правилом, а не вручную', () => {
    expect(chat).toContain('hitLabel(searchHitIdx, searchHitIndices.length)');
    expect(chat).toContain('stepHitIndex(searchHitIdx, searchHitIndices.length, -1)');
    expect(chat).toContain('stepHitIndex(searchHitIdx, searchHitIndices.length, 1)');
    expect(chat).not.toContain('searchHitIdx + 1}/{');
    expect(groups).toContain('hitLabel(searchIdx, searchResults.length)');
    expect(groups).toContain('stepHitIndex(searchIdx, searchResults.length, 1)');
    expect(groups).toContain('stepHitIndex(searchIdx, searchResults.length, -1)');
    expect(groups).not.toContain('% searchResults.length');
  });

  test('поиск в группе отбрасывает запоздавший ответ', () => {
    const m = groups.match(/void searchGroupMessages\([\s\S]*?\}, \[searchQuery, searchVisible, group\.id, pid\]\);/);
    expect(m).not.toBeNull();
    const block = m?.[0] ?? '';
    expect(block).toContain('if (!alive) return;');
    expect(groups).toContain('return () => { alive = false; clearTimeout(t); };');
  });

  test('оба экрана снимают запоздавший ответ поиска одинаково', () => {
    expect(chat).toContain('return () => { alive = false; clearTimeout(t); };');
  });
});
