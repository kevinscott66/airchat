/**
 * v4.32.495 — рэтчет на разбор личности.
 *
 * Эффект личности в App.tsx поднимает весь фон приложения: транспорт,
 * слушатели входящих, планировщик, присутствие, push. Тело у него
 * асинхронное, а снятие эффекта (переключение аккаунта, вход по паролю
 * заново) — синхронное. Значит между любыми двумя `await` внутри эффект
 * может оказаться уже снятым: teardown отработал, остановил всё, что на тот
 * момент было запущено, и больше никогда не повторится.
 *
 * Отсюда два правила, которые здесь и проверяются.
 *
 * 1. Перед каждым запуском службы после `await` должна стоять проверка
 *    `if (!alive) return;`. Без неё служба поднимается уже после разбора и
 *    остаётся работать под ключами закрытого аккаунта — остановить её нечем.
 * 2. У каждой запущенной службы должна быть парная остановка в teardown, а у
 *    каждого таймера — снятая ручка.
 *
 * Проверка идёт по исходнику: React-гарнитуры для рендера в проекте нет, а
 * правило по своей природе про порядок строк, а не про значения.
 */

import fs from 'fs';
import path from 'path';

const APP = path.join(__dirname, '..', 'App.tsx');
const source = fs.readFileSync(APP, 'utf8');

/** Тело эффекта личности: от объявления таймеров до массива зависимостей. */
function identityEffect(): { setup: string; teardown: string } {
  const from = source.indexOf('let purgeTimer: ReturnType<typeof setInterval>');
  const to = source.indexOf('}, [pair, did]);', from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const body = source.slice(from, to);
  const cut = body.indexOf('return () => {\n      alive = false;');
  expect(cut).toBeGreaterThan(0);
  return { setup: body.slice(0, cut), teardown: body.slice(cut) };
}

const { setup, teardown } = identityEffect();

/** Запуски фона: то, что нельзя поднимать после снятия эффекта. */
const STARTERS = [
  'initMessagingService(',
  'initPowerManager(',
  'startLanTransportIfEnabled(',
  'startInternetTransportIfEnabled(',
  'startNetworkReconnectWatcher(',
  'createMeshCoordinatorIfEnabled(',
  'startFeedInboxListener(',
  'resumeCommentOutbox(',
  'startStoryInboxListener(',
  'startScheduler(',
  'pushNotificationService.init(',
  'initCallService(',
  'loadPersistedPresence(',
  'startPresenceBroadcast(',
  'setInterval(',
  'setTimeout(',
] as const;

/** Запуск → парная остановка в teardown. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['initMessagingService(', 'getMessagingService()?.dispose()'],
  ['startLanTransportIfEnabled(', 'stopLanTransportStack()'],
  ['startInternetTransportIfEnabled(', 'stopInternetTransportStack()'],
  ['startNetworkReconnectWatcher(', 'stopNetworkReconnectWatcher()'],
  ['createMeshCoordinatorIfEnabled(', 'meshCoordinatorRef.current?.dispose()'],
  ['startFeedInboxListener(', 'stopFeedInboxListener()'],
  ['startStoryInboxListener(', 'stopStoryInboxListener()'],
  ['startScheduler(', 'stopScheduler()'],
  ['pushNotificationService.init(', 'disposePushNotificationService()'],
  ['startPresenceBroadcast(', 'stopPresenceBroadcast()'],
  ['setInterval(', 'clearInterval(purgeTimer)'],
  ['setTimeout(', 'clearTimeout(sweepTimer)'],
];

/**
 * Служебные вызовы без остановки — каждый со своей причиной. Список нужен,
 * чтобы новый запуск без пары нельзя было добавить молча.
 */
const NO_STOP: Record<string, string> = {
  'initPowerManager(': 'настройка режима питания, состояния не держит',
  'resumeCommentOutbox(': 'разовый дренаж очереди, сам себя исчерпывает',
  'initCallService(': 'регистрация в сигнальном слое поверх транспорта, который останавливается ниже',
  'loadPersistedPresence(': 'чтение кэша присутствия, ничего не поднимает',
};

describe('разбор личности: запуск после снятия эффекта', () => {
  it.each(STARTERS.map((s) => [s] as const))(
    'перед «%s» после await стоит проверка alive',
    (starter) => {
      const at = setup.indexOf(starter);
      expect(at).toBeGreaterThan(0);
      // Начало строки с запуском: свой же await в счёт не идёт.
      const lineStart = setup.lastIndexOf('\n', at) + 1;
      const before = setup.slice(0, lineStart);
      const lastAwait = before.lastIndexOf('await ');
      if (lastAwait < 0) return; // до первого await эффект заведомо жив
      expect(before.slice(lastAwait)).toContain('if (!alive) return;');
    },
  );

  it('каждый запуск помянут ровно один раз: пары и исключения не пересекаются', () => {
    const paired = new Set(PAIRS.map(([s]) => s));
    for (const starter of STARTERS) {
      const inPairs = paired.has(starter);
      const inExempt = starter in NO_STOP;
      expect([inPairs, inExempt]).toContain(true);
      expect(inPairs && inExempt).toBe(false);
    }
  });

  it.each(PAIRS)('«%s» останавливается в teardown через «%s»', (starter, stopper) => {
    expect(setup).toContain(starter);
    expect(teardown).toContain(stopper);
  });

  it('teardown первым делом снимает флаг alive', () => {
    expect(teardown.startsWith('return () => {\n      alive = false;')).toBe(true);
  });

  it('обе ручки таймеров объявлены и обнуляются', () => {
    expect(setup).toContain('let purgeTimer: ReturnType<typeof setInterval> | null = null;');
    expect(setup).toContain('let sweepTimer: ReturnType<typeof setTimeout> | null = null;');
    expect(setup).toContain('purgeTimer = setInterval(');
    expect(setup).toContain('sweepTimer = setTimeout(');
  });

  it('отложенная уборка кэша ещё и сама смотрит на alive', () => {
    const at = setup.indexOf('sweepTimer = setTimeout(');
    expect(at).toBeGreaterThan(0);
    expect(setup.slice(at, at + 200)).toContain('if (!alive) return;');
  });

  it('разбор выключает планировщик и слушатели, а не только транспорт', () => {
    for (const stopper of ['stopScheduler()', 'stopStoryInboxListener()', 'stopFeedInboxListener()']) {
      expect(teardown).toContain(stopper);
    }
  });
});

describe('почему проверка нужна именно после await', () => {
  /** Модель эффекта: снятие синхронно, тело — нет. */
  function effect(guard: boolean, started: string[]): { release: () => void; cleanup: () => void } {
    let alive = true;
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    void (async () => {
      await gate;
      if (guard && !alive) return;
      started.push('scheduler');
    })();
    return { release, cleanup: () => { alive = false; } };
  }

  it('без проверки служба поднимается уже после разбора', async () => {
    const started: string[] = [];
    const e = effect(false, started);
    e.cleanup();
    e.release();
    await Promise.resolve();
    expect(started).toEqual(['scheduler']);
  });

  it('с проверкой — не поднимается', async () => {
    const started: string[] = [];
    const e = effect(true, started);
    e.cleanup();
    e.release();
    await Promise.resolve();
    expect(started).toEqual([]);
  });

  it('без снятия эффекта проверка ничему не мешает', async () => {
    const started: string[] = [];
    const e = effect(true, started);
    e.release();
    await Promise.resolve();
    expect(started).toEqual(['scheduler']);
  });
});
