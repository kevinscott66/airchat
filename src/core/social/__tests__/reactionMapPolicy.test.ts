/**
 * Карта реакций одного сообщения (v4.32.509).
 *
 * Проверяются два потолка (на участника и на сообщение), их несимметричность
 * — снять своё можно всегда — и то, что разбор ячейки теперь один на все
 * места, где она читается.
 */
import fs from 'fs';
import path from 'path';
import {
  MAX_REACTIONS_PER_ACTOR,
  MAX_REACTION_KEYS,
  type ReactionMap,
  actorHasReaction,
  actorReactionCount,
  applyReaction,
  canAddReaction,
  parseReactionMap,
  serializeReactionMap,
} from '../reactionMapPolicy';

const SRC = path.join(__dirname, '..', '..', '..');
const ME = 'me-pub-key';
const THEM = 'them-pub-key';

/** Карта, где `actor` держит `n` различных эмодзи. */
function mapWithActor(actor: string, n: number): ReactionMap {
  const m: ReactionMap = {};
  for (let i = 0; i < n; i++) m[`e${i}`] = [actor];
  return m;
}

describe('parseReactionMap — своя же ячейка проверяется как чужая', () => {
  test('обычная карта разбирается', () => {
    expect(parseReactionMap('{"👍":["a","b"]}')).toEqual({ '👍': ['a', 'b'] });
  });

  test('пусто и мусор дают пустую карту, а не бросок', () => {
    expect(parseReactionMap(null)).toEqual({});
    expect(parseReactionMap(undefined)).toEqual({});
    expect(parseReactionMap('')).toEqual({});
    expect(parseReactionMap('{сломанный')).toEqual({});
  });

  test('массив, null и примитив картой не являются', () => {
    expect(parseReactionMap('[1,2]')).toEqual({});
    expect(parseReactionMap('null')).toEqual({});
    expect(parseReactionMap('42')).toEqual({});
    expect(parseReactionMap('"строка"')).toEqual({});
  });

  test('значение по эмодзи обязано быть списком строк', () => {
    // Ровно то, что копии разбора по экранам принимали на веру: `dids.length`
    // у строки — её длина, и в пузыре рисовался счётчик «3».
    expect(parseReactionMap('{"👍":"abc"}')).toEqual({});
    expect(parseReactionMap('{"👍":5}')).toEqual({});
    expect(parseReactionMap('{"👍":{"a":1}}')).toEqual({});
    expect(parseReactionMap('{"👍":["a",7,null,"b"]}')).toEqual({ '👍': ['a', 'b'] });
  });

  test('пустой список ключа не оставляет', () => {
    expect(parseReactionMap('{"👍":[]}')).toEqual({});
  });
});

describe('потолок на участника', () => {
  test('свой предел достижим целиком', () => {
    const m = mapWithActor(ME, MAX_REACTIONS_PER_ACTOR - 1);
    expect(canAddReaction(m, 'новый', ME)).toBe(true);
  });

  test('за пределом новую реакцию не добавить', () => {
    const m = mapWithActor(ME, MAX_REACTIONS_PER_ACTOR);
    expect(canAddReaction(m, 'новый', ME)).toBe(false);
    expect(applyReaction(m, 'новый', ME, true)).toBeNull();
  });

  test('упёршийся в потолок снимает своё без спроса', () => {
    const m = mapWithActor(ME, MAX_REACTIONS_PER_ACTOR);
    const res = applyReaction(m, 'e0', ME, false);
    expect(res).not.toBeNull();
    expect(res?.on).toBe(false);
    expect(actorReactionCount(res?.map ?? {}, ME)).toBe(MAX_REACTIONS_PER_ACTOR - 1);
  });

  test('чужой потолок не мешает мне', () => {
    const m = mapWithActor(THEM, MAX_REACTIONS_PER_ACTOR);
    expect(canAddReaction(m, 'мой', ME)).toBe(true);
  });

  test('присоединиться к уже существующему эмодзи можно и на пределе', () => {
    const m = mapWithActor(ME, MAX_REACTIONS_PER_ACTOR);
    m['общий'] = [THEM];
    // Это НОВЫЙ для меня эмодзи, поэтому потолок участника всё же держит.
    expect(canAddReaction(m, 'общий', ME)).toBe(false);
  });
});

describe('потолок на сообщение', () => {
  test('до предела новые ключи добавляются', () => {
    const m: ReactionMap = {};
    for (let i = 0; i < MAX_REACTION_KEYS - 1; i++) m[`e${i}`] = [`user${i}`];
    expect(canAddReaction(m, 'ещё', ME)).toBe(true);
  });

  test('за пределом новый ключ не создаётся — толпа не вешает пузырь', () => {
    const m: ReactionMap = {};
    for (let i = 0; i < MAX_REACTION_KEYS; i++) m[`e${i}`] = [`user${i}`];
    expect(canAddReaction(m, 'ещё', ME)).toBe(false);
    expect(applyReaction(m, 'ещё', ME, true)).toBeNull();
  });

  test('на переполненном сообщении существующий эмодзи по-прежнему доступен', () => {
    const m: ReactionMap = {};
    for (let i = 0; i < MAX_REACTION_KEYS; i++) m[`e${i}`] = [`user${i}`];
    expect(canAddReaction(m, 'e0', ME)).toBe(true);
    const res = applyReaction(m, 'e0', ME, true);
    expect(res?.map['e0']).toEqual(['user0', ME]);
  });

  test('на переполненном сообщении своё снимается всегда', () => {
    const m: ReactionMap = {};
    for (let i = 0; i < MAX_REACTION_KEYS; i++) m[`e${i}`] = [ME];
    const res = applyReaction(m, 'e5', ME, false);
    expect(res).not.toBeNull();
    expect(res?.map['e5']).toBeUndefined();
  });
});

describe('applyReaction', () => {
  test('переключение туда и обратно', () => {
    const empty: ReactionMap = {};
    const on = applyReaction(empty, '👍', ME, 'toggle');
    expect(on?.on).toBe(true);
    expect(on?.map).toEqual({ '👍': [ME] });
    const off = applyReaction(on?.map ?? {}, '👍', ME, 'toggle');
    expect(off?.on).toBe(false);
    expect(off?.map).toEqual({});
  });

  test('повторное включение уже включённого ничего не ломает', () => {
    const m: ReactionMap = { '👍': [ME] };
    const res = applyReaction(m, '👍', ME, true);
    expect(res?.on).toBe(true);
    expect(res?.map).toEqual({ '👍': [ME] });
  });

  test('снятие того, чего нет, не создаёт ключа', () => {
    const res = applyReaction({}, '👍', ME, false);
    expect(res?.on).toBe(false);
    expect(res?.map).toEqual({});
  });

  test('чужая реакция не стирается моей', () => {
    const m: ReactionMap = { '👍': [THEM] };
    const res = applyReaction(m, '👍', ME, true);
    expect(res?.map['👍']).toEqual([THEM, ME]);
  });

  test('снятие моей не трогает чужую', () => {
    const m: ReactionMap = { '👍': [THEM, ME] };
    const res = applyReaction(m, '👍', ME, false);
    expect(res?.map['👍']).toEqual([THEM]);
  });

  test('исходная карта не меняется', () => {
    const m: ReactionMap = { '👍': [THEM] };
    applyReaction(m, '👍', ME, true);
    applyReaction(m, '🔥', ME, true);
    expect(m).toEqual({ '👍': [THEM] });
  });

  test('actorHasReaction и actorReactionCount видят одно и то же', () => {
    const m: ReactionMap = { '👍': [ME, THEM], '🔥': [THEM] };
    expect(actorHasReaction(m, '👍', ME)).toBe(true);
    expect(actorHasReaction(m, '🔥', ME)).toBe(false);
    expect(actorReactionCount(m, ME)).toBe(1);
    expect(actorReactionCount(m, THEM)).toBe(2);
  });
});

describe('serializeReactionMap', () => {
  test('пустая карта — null, а не «{}»', () => {
    expect(serializeReactionMap({})).toBeNull();
  });

  test('запись и разбор — обратимая пара', () => {
    const m: ReactionMap = { '👍': [ME, THEM], '🔥': [ME] };
    expect(parseReactionMap(serializeReactionMap(m))).toEqual(m);
  });
});

describe('форма исходников — v4.32.509', () => {
  const mod = fs.readFileSync(path.join(SRC, 'core', 'social', 'reactionMapPolicy.ts'), 'utf8');
  const local = fs.readFileSync(path.join(SRC, 'core', 'storage', 'local.ts'), 'utf8');
  const screens = ['ChatScreen.tsx', 'GroupsScreen.tsx', 'ChatListScreen.tsx'].map((n) =>
    fs.readFileSync(path.join(SRC, 'ui', 'screens', n), 'utf8')
  );
  const bar = fs.readFileSync(
    path.join(SRC, 'ui', 'screens', 'chat-components', 'ReactionBar.tsx'),
    'utf8'
  );

  test('модуль без импортов', () => {
    expect(mod).not.toMatch(/^import\s/m);
    expect(mod).not.toContain('require(');
  });

  test('запись реакции идёт через потолки и общий разбор', () => {
    // v4.32.544: читаем через readAtRestCell — нечитаемый столбец больше не
    // выглядит как «реакций не было» и не переписывается одной новой.
    expect(local).toContain('const map = parseReactionMap(cellTextOrNull(cell));');
    expect(local).toContain('const cell = readAtRestCell(row.reactions, dek);');
    expect(local).toContain('const applied = applyReaction(map, emoji, actorKey, on);');
    expect(local).toContain("log.warn('reaction_rejected_limit'");
    expect(local).toContain('const json = serializeReactionMap(applied.map);');
  });

  test('своей склейки карты в хранилище не осталось', () => {
    expect(local).not.toContain("if (users.length) map[emoji] = users; else delete map[emoji];");
    expect(local).not.toContain('const has = users.includes(actorKey);');
  });

  test('ни один экран не разбирает ячейку сам', () => {
    for (const body of [...screens, bar]) {
      expect(body).not.toContain('JSON.parse(item.reactions');
      expect(body).not.toContain('JSON.parse(r.message.reactions');
      expect(body).not.toContain('JSON.parse(reactions');
    }
  });

  test('все четыре места читают ячейку одним правилом', () => {
    // v4.32.605: строка выдачи поиска зовёт разбор не сама, а через
    // searchReactionChip — он же и отделяет «не прочиталось» от «нет реакций».
    // Правило по-прежнему одно; своего разбора не завёл никто.
    for (const body of [...screens, bar]) {
      expect(
        body.includes('parseReactionMap(') || body.includes('searchReactionChip(')
      ).toBe(true);
    }
  });
});
