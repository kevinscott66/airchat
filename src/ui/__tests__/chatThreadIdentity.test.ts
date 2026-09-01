import * as fs from 'fs';
import * as path from 'path';

/**
 * Экран разговора обязан пересоздаваться при смене разговора (v4.32.434,
 * распространено на группы в v4.32.494).
 *
 * Переход из «Контактов» ставит нового собеседника поверх старого, минуя
 * null. Без key React переиспользует тот же экземпляр ChatThreadView, и всё
 * его состояние — набранный текст, цитата, правка, выделение — остаётся от
 * прошлой переписки. Цитата особенно неприятна: её превью это копия текста
 * чужого сообщения, то есть содержимое одной переписки попадает в другую.
 *
 * В группах то же самое и по той же причине: всплывающая плашка уведомления
 * ставит другую группу поверх открытой, минуя список. Там к чужому черновику
 * и цитате добавляются обои, размер шрифта и снимки настроек — «только
 * админы», медленный режим, срок исчезновения — снятые с прошлой группы.
 * Недописанное сообщение для одних людей уходило бы другим.
 *
 * Чинить это сбросом каждого useState по ключу разговора — то самое «одно
 * правило, полсотни копий»: любое новое поле придётся не забыть. Ремоунт по
 * ключу делает ошибку ненаписуемой.
 */

const UI = path.join(__dirname, '..');

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(full));
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Экраны разговора и ключ, которым каждый обязан пересоздаваться. */
const KEYED = [
  { tag: '<ChatThreadView', key: 'key={openPeer.pubB64}', home: 'screens/ChatScreen.tsx' },
  { tag: '<GroupChatScreen', key: 'key={nav.group.id}', home: 'screens/GroupsScreen.tsx' },
  { tag: '<GroupMembersScreen', key: 'key={nav.group.id}', home: 'screens/GroupsScreen.tsx' },
] as const;

const TAG = KEYED[0].tag;

/** Каждое место отрисовки тега — от него до закрывающего `/>`. */
function renderSites(source: string, tag: string = TAG): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(tag, from);
    if (start < 0) return out;
    const end = source.indexOf('/>', start);
    if (end < 0) {
      out.push(source.slice(start));
      return out;
    }
    out.push(source.slice(start, end + 2));
    from = end + 2;
  }
}

function sitesWithoutKey(source: string, tag: string = TAG, key: string = KEYED[0].key): string[] {
  return renderSites(source, tag).filter((block) => !block.includes(key));
}

/**
 * Тела эффектов, завязанных ровно на peerB64.
 *
 * Ищем от закрывающей строки назад, к ближайшему открывающему useEffect:
 * поиск вперёд от useEffect нежадным `[\s\S]*?` склеивал бы несколько
 * эффектов подряд, пока не встретится первый нужный список зависимостей.
 */
function peerEffectBodies(source: string): string[] {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '}, [peerB64]);') continue;
    let start = -1;
    for (let j = i; j >= 0; j -= 1) {
      if (lines[j].includes('useEffect(() => {')) { start = j; break; }
    }
    if (start >= 0) out.push(lines.slice(start, i + 1).join('\n'));
  }
  return out;
}

const FILES = collect(UI).map((full) => ({
  key: path.relative(UI, full).split(path.sep).join('/'),
  source: fs.readFileSync(full, 'utf8'),
}));

const SCREEN = FILES.find((f) => f.key === 'screens/ChatScreen.tsx');

describe('экран разговора пересоздаётся под каждый разговор', () => {
  it.each(KEYED.map((k) => [k.tag, k] as const))('%s есть в дереве UI ровно один раз', (_tag, entry) => {
    const home = FILES.find((f) => f.key === entry.home);
    expect(home).toBeDefined();
    expect(renderSites(home!.source, entry.tag).length).toBe(1);
  });

  it.each(KEYED.map((k) => [k.tag, k] as const))('%s: ни одно место отрисовки не обходится без key', (_tag, entry) => {
    const offenders = FILES.filter((f) => sitesWithoutKey(f.source, entry.tag, entry.key).length > 0).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('проверка не пустая: тот же разбор ловит отрисовку без key', () => {
    const bad = `      <SafeScreen>\n        ${TAG}\n          pair={pair}\n          peerB64={openPeer.pubB64}\n        />\n      </SafeScreen>`;
    expect(sitesWithoutKey(bad).length).toBe(1);
  });

  it('проверка не пустая: отрисовка с key проходит', () => {
    const good = `        ${TAG}\n          key={openPeer.pubB64}\n          peerB64={openPeer.pubB64}\n        />`;
    expect(renderSites(good).length).toBe(1);
    expect(sitesWithoutKey(good)).toEqual([]);
  });
});

describe('ключ нужен именно потому, что разговор меняется напрямую', () => {
  it('переход из «Контактов» ставит нового собеседника поверх старого', () => {
    expect(SCREEN!.source).toContain('setOpenPeer({ pubB64: pub, displayName: shortIdentity(pub) });');
  });

  it('плашка уведомления ставит другую группу поверх открытой', () => {
    const groups = FILES.find((f) => f.key === 'screens/GroupsScreen.tsx');
    // v4.32.548: группа для перехода теперь берётся из базы, а не только из
    // списка в памяти, — но подстановка поверх открытого разговора та же.
    expect(groups!.source).toContain("setNav({ screen: 'chat', group: target });");
  });

  it('черновик группы дописывается при уходе, а не теряется при ремоунте', () => {
    const groups = FILES.find((f) => f.key === 'screens/GroupsScreen.tsx');
    expect(groups!.source).toContain('return () => { flushGroupDraft(); };');
  });

  it('состояние композера не сбрасывается вручную по peerB64', () => {
    const effects = peerEffectBodies(SCREEN!.source);
    expect(effects.length).toBeGreaterThan(0);
    const manualResets = effects.filter(
      (body) =>
        body.includes("setMsg('')") || body.includes('setReplyTo(null)') || body.includes('setEditTarget(null)')
    );
    // Если такой сброс появился — значит правило снова размазали по полям.
    // Сброс делает ремоунт по key, а не эффект.
    expect(manualResets).toEqual([]);
  });

  it('черновик дописывается при уходе из переписки, а не теряется при ремоунте', () => {
    expect(SCREEN!.source).toContain('return () => { flushDraft(); };');
  });
});
