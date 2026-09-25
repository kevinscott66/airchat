import fs from 'fs';
import path from 'path';

/**
 * Поздний ответ поиска больше не подменяет находки под новым запросом
 * (v4.32.962).
 *
 * ДЕФЕКТ. Поиск по всем группам сразу снимал только таймер отсрочки. Таймер
 * спасает от запроса, который ещё НЕ УШЁЛ; ушедший возвращался когда угодно и
 * записывал свои находки безусловно.
 *
 * ЦЕНА. Этот поиск идёт по истории всех групп, то есть дольше остальных. Пока
 * он считает «проект», человек дописывает «проектная смета»; короткий второй
 * проход возвращается первым, следом приходит первый — и под новой строкой
 * поиска ложится список находок по старой. Слов из запроса в найденном нет,
 * переход по строке уводит в сообщение, которого не искали, а приписка
 * «просмотрено не всё» приходит из того же устаревшего ответа.
 *
 * ПРАВКА. Флаг живости, как у трёх соседних поисков: внутри группы
 * (v4.32.506), в переписке (v4.32.239) и на списке чатов (v4.32.184).
 *
 * ФОРМА. Проверка по исходникам — намеренно, и по той же причине, что в
 * `silentFailurePaths622`: эффект живёт внутри экрана на шесть тысяч строк,
 * поведенческий тест на него стоил бы дороже самой правки. Зато проверка
 * сделана обходом: она находит ВСЕ отложенные поиски в экранах и требует флаг
 * у каждого. Три из четырёх проходили и до правки — это и есть её контроль;
 * пятый, который кто-нибудь напишет завтра, тоже не проскочит.
 */

const SCREENS = path.join(__dirname, '..', 'screens');

/** Исходник без строк-комментариев: пояснение не должно подменять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

type Site = { file: string; line: number; window: string };

/**
 * Все отложенные поиски в экранах: вызов `searchXxx(...).then(`, у которого в
 * том же эффекте стоит `setTimeout`.
 */
function findDeferredSearches(): Site[] {
  const out: Site[] = [];
  for (const file of fs.readdirSync(SCREENS).filter((f) => f.endsWith('.tsx'))) {
    const src = codeOnly(fs.readFileSync(path.join(SCREENS, file), 'utf8'));
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      if (!/\bsearch[A-Za-z]*\(.*\)\.then\(/.test(l)) return;
      // Окно эффекта: от `useEffect` выше до закрытия ниже. Берём с запасом —
      // проверяется наличие флага, а не расстояние до него.
      const from = Math.max(0, i - 12);
      const window = lines.slice(from, i + 12).join('\n');
      if (!window.includes('setTimeout(')) return;
      out.push({ file, line: i + 1, window });
    });
  }
  return out;
}

const SITES = findDeferredSearches();

describe('отложенный поиск в экранах сверяет живость перед записью', () => {
  it('обход вообще что-то нашёл — иначе проверка проходила бы впустую', () => {
    expect(SITES.length).toBeGreaterThanOrEqual(4);
  });

  it('поиск по всем группам сразу — в списке найденных мест', () => {
    const at = SITES.find((s) => s.window.includes('searchAllGroupMessages('));
    expect(at).toBeDefined();
    expect(at?.file).toBe('GroupsScreen.tsx');
  });

  it.each(SITES.map((s) => [`${s.file}:${s.line}`, s] as const))(
    'у %s есть флаг живости',
    (_name, site) => {
      expect(site.window).toContain('let alive = true;');
      expect(site.window).toContain('if (!alive) return;');
      expect(site.window).toContain('alive = false;');
    },
  );
});

describe('ГРАНИЦА: отсрочка осталась отсрочкой', () => {
  it.each(SITES.map((s) => [`${s.file}:${s.line}`, s] as const))(
    '%s по-прежнему снимает таймер при уходе',
    (_name, site) => {
      expect(site.window).toMatch(/clearTimeout\(/);
    },
  );
});
