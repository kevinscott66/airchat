/**
 * Значение в зависимостях хука обязано быть устойчивым (v4.32.492).
 *
 * `FeedPollBlock` разбирал опрос прямо в теле компонента:
 * `const poll = parsePollText(pollText)`. Разбор собирает НОВЫЙ объект на
 * каждый вызов, а `poll` стоял в зависимостях `reload`, от которого зависит
 * эффект. Круг замыкался сам на себя: рендер → новый `poll` → новый `reload`
 * → эффект → `setVoteCounts(новый массив)` (по `Object.is` он никогда не
 * равен прежнему) → рендер. Цикл не сходится.
 *
 * Видно это не как ошибка, а как поведение телефона: человек долистал ленту
 * до поста с опросом и остановился — устройство греется, JS-поток занят
 * непрерывным чтением голосов из базы, нажатия по вкладкам «залипают»,
 * батарея садится. На экране при этом всё в порядке.
 *
 * Отдельно стоит заметить, что негодный опрос не зацикливался: разбор
 * возвращает `null`, а `null === null`. Страдали ровно исправные посты.
 */
import * as fs from 'fs';
import * as path from 'path';

import { makePollText, parsePollText } from '../../core/social/pollEnvelope';

const UI = path.join(__dirname, '..');

/** Все исходники экранов и компонентов. */
function uiFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__') walk(p);
      } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
        out.push(p);
      }
    }
  };
  walk(UI);
  return out;
}

const rel = (p: string): string => path.relative(UI, p);

/**
 * Разобранные значения, которым устойчивость не нужна: это строки, числа и
 * логические значения, а их зависимости сравнивают по значению.
 *
 * v4.32.512: `amAdmin` — это `isAdminRole(myRole)`, то есть boolean от
 * запомненной роли. Оборачивать его в useMemo не за чем: `true === true`.
 */
const VALUE_TYPED = new Set([
  'screens/GroupsScreen.tsx:slowKey',
  'screens/GroupsScreen.tsx:amAdmin',
  'screens/ChatScreen.tsx:url',
]);

describe('разбор опроса не сохраняет тождество', () => {
  const text = makePollText('Пойдём?', ['Да', 'Нет']);

  it('два разбора одного текста дают равные, но РАЗНЫЕ объекты', () => {
    const a = parsePollText(text);
    const b = parsePollText(text);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('и массив вариантов внутри тоже другой', () => {
    expect(parsePollText(text)?.options).not.toBe(parsePollText(text)?.options);
  });

  it('негодный опрос устойчив — он и не зацикливался', () => {
    expect(parsePollText('обычный текст')).toBeNull();
    expect(parsePollText('обычный текст')).toBe(parsePollText('обычный текст'));
  });
});

describe('форма исходников', () => {
  it.each([
    'screens/FeedScreen.tsx',
    'screens/chat-components/DmPollBubble.tsx',
    'screens/groups-components/PollBubble.tsx',
  ])('%s запоминает разбор по тексту конверта', (file) => {
    const src = fs.readFileSync(path.join(UI, file), 'utf8');
    expect(src).toContain('useMemo(() => parsePollText(pollText), [pollText])');
    expect(src).not.toMatch(/const poll = parsePollText\(/);
  });

  it('ни одно вычисленное значение не попадает в зависимости хука незапомненным', () => {
    const offenders: string[] = [];
    for (const file of uiFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      // `const NAME = fn(` — но не сам хук (useMemo/useCallback/useState/…).
      const declared = new Map<string, string>();
      for (const m of src.matchAll(/^\s*const (\w+) = (?!use[A-Z])(\w+)\(/gm)) {
        declared.set(m[1], m[2]);
      }
      if (declared.size === 0) continue;
      for (const d of src.matchAll(/\}, \[([^\]]*)\]\)/g)) {
        for (const dep of d[1].split(',').map((x) => x.trim())) {
          const fn = declared.get(dep);
          if (!fn) continue;
          const key = `${rel(file)}:${dep}`;
          if (VALUE_TYPED.has(key)) continue;
          offenders.push(`${key} = ${fn}()`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
