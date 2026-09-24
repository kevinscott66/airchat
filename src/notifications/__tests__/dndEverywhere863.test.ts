/**
 * v4.32.863. «Не беспокоить» спрашивали не все, кто будит телефон.
 *
 * Дефект. Окно тишины проверяли ровно два места: баннер личного сообщения и
 * баннер группового. Публикация в ленте и комментарий к ней (`notifyFeedEvent`)
 * и «вам звонили» (`notifyMissedCall`) показывались как ни в чём не бывало —
 * со звуком и вибрацией, в три часа ночи, при включённом переключателе. То
 * есть настройка не работала ровно в том случае, ради которого её включают.
 *
 * Цена. Человек, выставивший окно тишины, всё равно просыпается — и не от
 * сообщения, а от чужой публикации. Доверие к переключателю после этого
 * кончается: он либо выключает уведомления целиком, либо перестаёт верить
 * настройкам вообще.
 *
 * Правка — по уже написанной доктрине, а не по новой. Её держит
 * `backgroundNotifyPrefs`: сообщение в окно тишины ПРЯЧУТ (оно никуда не
 * денется — лежит в переписке), а звонок только ОБЕЗЗВУЧИВАЮТ (спрятать
 * значит съесть молча). Событие ленты — сообщение по этой мерке: прячем.
 * «Вам звонили» — звонок: показываем беззвучно. Непринятые звонки сервер
 * отдаёт один раз, при входе, и показать их потом будет нечем.
 *
 * Проверяется исходник: оба показа зовут notifee через require внутри try,
 * поднять их в jest нельзя, а суть правки — в том, какая ветка что делает с
 * баннером. Само правило окна — чистая функция, и у неё свои тесты
 * (dndWindow), здесь они не повторяются.
 */
import * as fs from 'fs';
import * as path from 'path';

const PUSH_PATH = path.join(__dirname, '..', 'pushNotifications.ts');
const PREFS_PATH = path.join(__dirname, '..', 'backgroundNotifyPrefs.ts');

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

const PUSH = (): string => codeOnly(fs.readFileSync(PUSH_PATH, 'utf8'));
const PREFS = (): string => codeOnly(fs.readFileSync(PREFS_PATH, 'utf8'));

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const FEED = (): string => slice(PUSH(), 'export async function notifyFeedEvent(', 'export async function notifyMissedCall(');
const MISSED = (): string => slice(PUSH(), 'export async function notifyMissedCall(', 'export async function');

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники читаются и это те самые показы', () => {
    expect(PUSH().length).toBeGreaterThan(5000);
    expect(FEED()).toContain('notifee.displayNotification({');
    expect(MISSED()).toContain("id: 'airchat_missed_calls',");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('окно тишины по-прежнему считает одна функция на весь модуль', () => {
    expect(PUSH()).toContain('async function isDndActive(): Promise<boolean> {');
    const body = slice(PUSH(), 'async function isDndActive(): Promise<boolean> {', 'const FCM_TOKEN_KEY');
    expect(body).toContain("kvGet('dnd_enabled')");
    expect(body).toContain('isWithinDndWindow(start, end, new Date().getHours())');
  });

  it('оба показа по-прежнему не спрашивают общий читатель настроек', () => {
    expect(FEED()).not.toContain('readBackgroundNotifyPrefs');
    expect(MISSED()).not.toContain('readBackgroundCallPrefs');
  });

  it('доктрина, по которой правим, записана и не менялась', () => {
    const msg = slice(PREFS(), 'export async function readBackgroundNotifyPrefs(', 'export async function readBackgroundCallPrefs(');
    expect(msg).toContain('return { show: false, sound: false, vibrate: false };');
    const call = slice(PREFS(), 'export async function readBackgroundCallPrefs(', 'export async function isBackgroundMuted(');
    expect(call).toContain('return { show: true, sound: false, vibrate: false };');
  });
});

describe('окно тишины спрашивают все, кто будит телефон', () => {
  it('ни один показ не обходит проверку стороной', () => {
    const asks = PUSH().split('isDndActive()').length - 1;
    // Объявление плюс четыре спроса: личное, групповое, лента, «вам звонили».
    expect(asks).toBe(5);
  });

  it('лента прячется — как сообщение', () => {
    const body = slice(FEED(), "kvGet('notify_feed')", 'notifee.displayNotification({');
    expect(body).toContain('if (await isDndActive()) return;');
  });

  it('у ленты проверка стоит до показа, а не после', () => {
    const feed = FEED();
    const asked = feed.indexOf('isDndActive()');
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(feed.indexOf('notifee.displayNotification({'));
  });
});

describe('пропущенный звонок не прячут: показать его потом будет нечем', () => {
  it('окно тишины гасит звук и вибрацию, а не баннер', () => {
    const body = MISSED();
    expect(body).toContain('const quiet = await isDndActive();');
    expect(body).toContain("const vibrate = !quiet && (await kvGet('notify_vibrate')) !== 'false';");
    expect(body).toContain("const sound = !quiet && (await kvGet('notify_sound')) !== 'false';");
  });

  it('раннего выхода по окну тишины здесь нет', () => {
    expect(MISSED()).not.toContain('if (await isDndActive()) return;');
    expect(MISSED()).not.toContain('if (quiet) return;');
  });

  it('беззвучность доезжает до самого баннера', () => {
    const body = MISSED();
    expect(body).toContain("vibrationPattern: vibrationFor(vibrate, 'message'),");
    expect(body).toContain("sound: sound ? 'default' : undefined,");
  });
});

describe('выключатели разделов не тронуты', () => {
  it('свой выключатель у каждого раздела остался первым словом', () => {
    const feed = FEED();
    expect(feed.indexOf("kvGet('notify_feed')")).toBeLessThan(feed.indexOf('isDndActive()'));
    const missed = MISSED();
    expect(missed.indexOf("kvGet('notify_calls')")).toBeLessThan(missed.indexOf('isDndActive()'));
  });

  it('нулевого счётчика по-прежнему нет — баннер «вам звонили: 0» не показывается', () => {
    expect(MISSED()).toContain('if (opts.count <= 0) return;');
  });
});
