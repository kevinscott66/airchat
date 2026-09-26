/**
 * v4.32.860. Об одном отказе говорили дважды, о потерянной записи — ни разу.
 *
 * Отправка отказывает по разным причинам, и три из них объясняет сама, прямо
 * из ядра: «Контакт заблокирован», «Слишком много сообщений этому контакту»,
 * «Нет защищённого канала». Экран об этом не знал и на любой отказ добавлял
 * своё: «Попробуйте ещё раз», «Запишите заново». Получалось два разных
 * сообщения об одном событии — причём второе не дополняло первое, а спорило с
 * ним: заблокированному контакту не поможет ни одна повторная попытка, и
 * человек честно повторял, пока не сдавался. Хуже всего это выходило с
 * голосовым: там совет «запишите заново» летел через общий `throw`, то есть
 * подменял собой любую причину.
 *
 * Вторая половина правки — о записи. Свёрнутое приложение останавливало
 * рекордер и стирало файл из кэша: правильно, иначе на мёртвом экране осталась
 * бы работающая запись. Но не говорило ничего. Человек, у которого на пятой
 * минуте рассказа зазвонил телефон, возвращался к прежнему экрану и был
 * уверен, что запись идёт. Сказать в момент потери нельзя — приложение в этот
 * миг свёрнуто, и тост истечёт за спиной; поэтому потеря запоминается, а слово
 * ждёт возвращения.
 *
 * Проверяется исходник: ни экран переписки, ни кнопка записи в jest не
 * поднимаются, а вся суть правки — в том, какая ветка что говорит. Само
 * правило «молчать, если уже сказано» — функция, и она проверяется работой.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../appNotify', () => ({
  pushToast: jest.fn(() => true),
  pushConfirm: jest.fn(() => true),
}));
jest.mock('../../../core/security/authGuard', () => ({
  authGuard: { getLockoutTimeRemaining: jest.fn(), getRemainingAttempts: jest.fn() },
}));

const UI = path.join(__dirname, '..');
const read = (...rel: string[]): string => fs.readFileSync(path.join(UI, ...rel), 'utf8');

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

const CHAT = (): string => codeOnly(read('..', 'screens', 'ChatScreen.tsx'));
const VOICE = (): string => codeOnly(read('VoiceMessage.tsx'));
const MESSAGING = (): string => codeOnly(read('..', '..', 'core', 'social', 'messaging.ts'));
const TOAST = (): string => read('AppToastLayer.tsx');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Тело слушателя AppState у кнопки записи. */
function recorderAppState(): string {
  return slice(VOICE(), "AppState.addEventListener('change'", 'return () => subscription.remove();');
}

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('все три исходника на месте и говорят об отказе отправки', () => {
    expect(CHAT()).toContain("if (res.outcome === 'refused')");
    expect(MESSAGING()).toContain('async sendMessageResult(');
    expect(VOICE()).toContain("AppState.addEventListener('change'");
  });

  it('слушатель AppState у кнопки записи разбирает именно уход из активного', () => {
    expect(recorderAppState()).toContain("state === 'active'");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ядро по-прежнему объясняет три отказа само — иначе экрану нечего уступать', () => {
    const src = MESSAGING();
    for (const code of ["code: 'BLOCKED_CONTACT',", "code: 'RATE_LIMIT_DM',", "code: 'NO_SESSION_DM',"]) {
      expect(src).toContain(code);
    }
    expect(src.split('ErrorHandler.getInstance().handle({').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('второе сообщение не встаёт в очередь, а вытесняет первое', () => {
    // Иначе «два сообщения об одном» были бы только многословием: человек
    // прочитал бы и причину, и совет. Тост один, и последний затирает прежний.
    expect(TOAST()).toContain('addToastListener((spec) => setToast(spec))');
  });

  it('свёрнутое приложение по-прежнему останавливает запись и стирает файл', () => {
    const body = recorderAppState();
    expect(body).toContain('recordingRef.current = null;');
    expect(body).toContain('void rec.stop()');
    expect(body).toContain('deleteCachedFileUris([rec.uri])');
  });

  it('у голосового уборка за собой осталась и в общем catch', () => {
    const body = slice(CHAT(), "log.error('voice_send_failed'", 'setSending(false);');
    expect(slice(CHAT(), 'setOptimisticOutgoing(null);\n        await deleteCachedFileUris', 'log.error(\'voice_send_failed\'')).toBeTruthy();
    expect(body).toContain("showError(userErrorText(e, 'Не удалось отправить голосовое'));");
  });
});

describe('об отказе говорят один раз', () => {
  it('объяснённый отказ экран не комментирует', async () => {
    const { reportSendRefusal } = await import('../userFeedback');
    const { pushToast } = await import('../appNotify');
    (pushToast as jest.Mock).mockClear();
    reportSendRefusal({ explained: true }, 'Попробуйте ещё раз');
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('необъяснённый отказ по-прежнему получает слово экрана', async () => {
    const { reportSendRefusal } = await import('../userFeedback');
    const { pushToast } = await import('../appNotify');
    for (const res of [{}, { explained: false }, { explained: undefined }]) {
      (pushToast as jest.Mock).mockClear();
      reportSendRefusal(res, 'Документ не отправлен');
      expect(pushToast).toHaveBeenCalledWith('error', 'Документ не отправлен');
    }
  });

  it('ядро помечает объяснённым ровно те отказы, о которых само и сказало', () => {
    const src = MESSAGING();
    expect(src.split("explained: true").length - 1).toBe(3);
    // Каждая пометка стоит сразу за баннером, а не где придётся.
    for (const code of ["code: 'BLOCKED_CONTACT',", "code: 'RATE_LIMIT_DM',", "code: 'NO_SESSION_DM',"]) {
      const from = src.indexOf(code);
      expect(from).toBeGreaterThan(0);
      const next = src.indexOf("return { outcome: 'refused'", from);
      expect(next).toBeGreaterThan(from);
      expect(src.slice(next, next + 80)).toContain('explained: true');
    }
  });

  it('молчаливые отказы пометки не носят — им слово экрана по-прежнему нужно', () => {
    const src = MESSAGING();
    // Служебный конверт сверх запаса, отсутствующий DID, не легший ряд.
    expect(src).toContain("if (!peerDid) return { outcome: 'refused', cid: null };");
    const control = slice(
      src,
      'if (!rateLimiter.canSendControl(contactPubB64)) {',
      '} else if (!rateLimiter.canSendMessage(contactPubB64)) {'
    );
    expect(control).toContain("return { outcome: 'refused', cid: null };");
    expect(control).not.toContain('explained');
  });

  it('ни один отказ на экране переписки не зовёт showError напрямую', () => {
    // Правило структурное: пропущенный вызов вернул бы второе сообщение
    // молча, и заметить это можно было бы только на заблокированном контакте.
    const chat = CHAT();
    const spots = [...chat.matchAll(/res\.outcome === 'refused'/g)].map((m) => m.index ?? 0);
    expect(spots).toHaveLength(9);
    let counters = 0;
    for (const at of spots) {
      const tail = chat.slice(at, at + 700);
      // Две пачки (видео и документы) считают адресатов и об отказе не говорят
      // вовсе — их отчёт общий и стоит после всего цикла.
      if (tail.startsWith("res.outcome === 'refused') { refusedCount++")) {
        counters++;
        continue;
      }
      const said = tail.indexOf('reportSendRefusal(res,');
      expect(said).toBeGreaterThan(0);
      expect(tail.slice(0, said)).not.toContain('showError(');
    }
    expect(counters).toBe(2);
  });

  it('все семь одиночных отказов говорят через общее правило', () => {
    expect(CHAT().split('reportSendRefusal(res,').length - 1).toBe(7);
    // v4.32.1001: в том же импорте появился reportErased — слово об остатке
    // расшифрованных вложений. Проверяется, что отказы по-прежнему берутся
    // из общего модуля, а не заводятся на экране заново.
    expect(CHAT()).toContain(
      "import { reportErased, reportSendRefusal, reportTwoSided, showConfirm, showError, showSuccess } from '../components/userFeedback';"
    );
  });

  it('отчёт о пачке остаётся общим — он считает адресатов, а не объясняет причину', () => {
    const chat = CHAT();
    expect(chat.split("if (res.outcome === 'refused') { refusedCount++; continue; }").length - 1).toBe(2);
    expect(chat.split('if (warn) showError(warn);').length - 1).toBe(2);
  });
});

describe('совет, который нельзя выполнить, убран', () => {
  it('отказ голосового больше не летит общим исключением', () => {
    const chat = CHAT();
    expect(chat).not.toContain("throw new Error('Голосовое не отправлено. Запишите заново.');");
    const body = slice(chat, 'const res = await svc.sendMessageResult(peerB64, voiceText);', 'await appendNewMessages();');
    expect(body).toContain("if (res.outcome === 'refused') {");
    expect(body).toContain("reportSendRefusal(res, 'Голосовое не отправлено. Запишите заново');");
  });

  it('отказ убирает за собой ровно то же, что убрал бы catch', () => {
    const body = slice(CHAT(), 'const res = await svc.sendMessageResult(peerB64, voiceText);', 'await appendNewMessages();');
    expect(body).toContain('setOptimisticOutgoing(null);');
    expect(body).toContain('await deleteCachedFileUris([result.uri]).catch(() => {});');
    expect(body).toContain("log.warn('voice_send_refused', { explained: res.explained === true });");
    // Ветка заканчивается сама: продолжение записало бы строку в переписку.
    expect(body).toContain('return;');
  });
});

describe('прерванная запись не исчезает молча', () => {
  it('потеря запоминается там же, где рекордер действительно был', () => {
    const body = recorderAppState();
    const rec = body.indexOf('if (rec) {');
    expect(rec).toBeGreaterThan(0);
    expect(body.indexOf('droppedRef.current = true;')).toBeGreaterThan(rec);
    // Пустое сворачивание — не потеря: без рекордера терять нечего.
    expect(body.split('droppedRef.current = true;').length - 1).toBe(1);
  });

  it('слово ждёт возвращения: свёрнутому приложению тост показывать некому', () => {
    const body = recorderAppState();
    const active = body.indexOf("if (state === 'active') {");
    expect(active).toBeGreaterThan(0);
    const said = body.indexOf('showError(');
    expect(said).toBeGreaterThan(active);
    expect(said).toBeLessThan(body.indexOf('droppedRef.current = true;'));
    expect(body).toContain('Запись прервана: приложение свернулось. Запишите заново');
  });

  it('сказанное не повторяется на каждом возвращении', () => {
    const body = recorderAppState();
    const returned = slice(body, "if (state === 'active') {", 'return;');
    expect(returned).toContain('if (droppedRef.current) {');
    expect(returned.indexOf('droppedRef.current = false;')).toBeLessThan(returned.indexOf('showError('));
  });

  it('ссылка на потерю — ref: перерисовки у свёрнутого экрана не будет', () => {
    expect(VOICE()).toContain('const droppedRef = useRef(false);');
  });
});
