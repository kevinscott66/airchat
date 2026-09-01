/**
 * Рэтчет к v4.32.605 — реакции в выдаче поиска.
 *
 * Дефект: обе выдачи — по личным чатам и по группам — строили плашку из
 * `Object.keys(parseReactionMap(...)).join('')`. У сообщения, чей столбец
 * `reactions` не открылся, в поле приходит пустая строка, карта выходит
 * пустой, плашка не рисуется — и строка выдачи неотличима от «на это никто
 * не реагировал». В пузыре сообщения это убрали в v4.32.600, в поиске
 * забыли.
 *
 * Держим и решение, и форму обоих мест: они были выписаны одинаковыми
 * копиями и разошлись бы снова.
 */
import fs from 'fs';
import path from 'path';

import {
  searchReactionChip,
  UNREADABLE_REACTION_MARK,
  type SearchReactionChip,
} from '../searchReactionChip';

const MODULE = path.join(__dirname, '..', 'searchReactionChip.ts');
const CHATS = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatListScreen.tsx');
const GROUPS = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx');

const moduleSrc = () => fs.readFileSync(MODULE, 'utf8');
const chatsSrc = () => fs.readFileSync(CHATS, 'utf8');
const groupsSrc = () => fs.readFileSync(GROUPS, 'utf8');

const map = (obj: Record<string, string[]>): string => JSON.stringify(obj);

describe('searchReactionChip: «не прочиталось» отделено от «реакций нет»', () => {
  it('непрочитанный столбец даёт пометку, а не пустоту', () => {
    const chip: SearchReactionChip = searchReactionChip('', true);
    expect(chip.kind).toBe('unreadable');
  });

  it('пустая карта у прочитанного столбца — это честное «нет реакций»', () => {
    expect(searchReactionChip('', false).kind).toBe('none');
    expect(searchReactionChip(null, false).kind).toBe('none');
    expect(searchReactionChip(undefined, undefined).kind).toBe('none');
    expect(searchReactionChip(map({}), false).kind).toBe('none');
  });

  it('прочитанные реакции склеиваются в строку эмодзи', () => {
    const chip = searchReactionChip(map({ A: ['k1'], B: ['k2'] }), false);
    expect(chip).toEqual({ kind: 'emoji', text: 'AB' });
  });

  it('признак проверяется раньше разбора карты', () => {
    // Иначе непрочитанный столбец свалился бы в «none» — сам дефект.
    const chip = searchReactionChip(map({ A: ['k1'] }), true);
    expect(chip.kind).toBe('unreadable');
  });

  it('признак читается строго по true', () => {
    expect(searchReactionChip(map({ A: ['k1'] }), false).kind).toBe('emoji');
    expect(searchReactionChip(map({ A: ['k1'] }), undefined).kind).toBe('emoji');
  });

  it('мусор в столбце не роняет разбор и не выдаётся за пометку', () => {
    expect(searchReactionChip('не json', false).kind).toBe('none');
    expect(searchReactionChip('[1,2]', false).kind).toBe('none');
    expect(searchReactionChip('null', false).kind).toBe('none');
  });

  it('знак пометки — один символ, чтобы не выдавить имя и время', () => {
    expect([...UNREADABLE_REACTION_MARK]).toHaveLength(1);
  });
});

describe('модуль остаётся чистым', () => {
  it('единственный импорт — такой же чистый разбор карты', () => {
    const imports = moduleSrc().split('\n').filter((l) => /^import\s/.test(l));
    expect(imports).toEqual(["import { parseReactionMap } from './reactionMapPolicy';"]);
  });
});

describe('обе выдачи поиска строят плашку одним решением', () => {
  const screens: Array<[string, () => string]> = [
    ['поиск по чатам', chatsSrc],
    ['поиск по группам', groupsSrc],
  ];

  it.each(screens)('%s зовёт searchReactionChip с признаком столбца', (_name, read) => {
    expect(read()).toContain(
      'const reactChip = searchReactionChip(r.message.reactions, r.message.reactionsUnreadable);'
    );
  });

  it.each(screens)('%s больше не склеивает ключи карты сам', (_name, read) => {
    expect(read()).not.toContain("Object.keys(parseReactionMap(r.message.reactions)).join('')");
  });

  it.each(screens)('%s рисует пометку, а не молчит', (_name, read) => {
    const src = read();
    expect(src).toContain("{reactChip.kind === 'unreadable' ? (");
    expect(src).toContain('{UNREADABLE_REACTION_MARK}</Text>');
  });

  it.each(screens)('%s даёт знаку подпись для озвучки', (_name, read) => {
    // Знак сам по себе ничего не сообщает тому, кто слушает экран.
    expect(read()).toContain('accessibilityLabel={UNREADABLE_REACTIONS_TEXT}');
  });

  it.each(screens)('%s помечает пометку цветом предупреждения', (_name, read) => {
    expect(read()).toContain('style={{ fontSize: 11, color: colors.warning }}');
  });

  it('поиск по чатам импортирует и решение, и полную фразу', () => {
    const src = chatsSrc();
    expect(src).toMatch(
      /^import \{ searchReactionChip, UNREADABLE_REACTION_MARK \} from '\.\.\/\.\.\/core\/social\/searchReactionChip';$/m
    );
    expect(src).toMatch(/^import \{[^}]*\bUNREADABLE_REACTIONS_TEXT\b[^}]*\} from '\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
  });

  it('поиск по группам импортирует и решение, и полную фразу', () => {
    const src = groupsSrc();
    expect(src).toMatch(
      /^import \{ searchReactionChip, UNREADABLE_REACTION_MARK \} from '\.\.\/\.\.\/core\/social\/searchReactionChip';$/m
    );
    expect(src).toMatch(/^import \{[^}]*\bUNREADABLE_REACTIONS_TEXT\b[^}]*\} from '\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
  });
});
