/**
 * v4.32.517. Уведомлений на Android не было вообще — и не из-за логики, а
 * из-за отсутствующего файла. Имя ресурса 'ic_notification' жило строковым
 * литералом в пяти вызовах notifee, ресурса с таким именем в проекте не
 * существовало, а шестой вызов (напоминания) small icon не задавал вовсе.
 * notifee в таком случае оставляет small icon пустым, Android отвечает
 * IllegalArgumentException, и каждый вызов гасил его собственным catch.
 *
 * Поэтому здесь два рода проверок. Первый — что связь «константа ↔ файл
 * ресурса» цела: имя совпадает с именем файла, файл на месте и является
 * пригодным vector drawable. Второй — что связь нельзя обойти: литерала в
 * исходниках больше нет, а каждый вызов notifee, который показывает
 * уведомление, задаёт small icon через константу.
 *
 * Отдельная тонкость: каталог android/ целиком в .gitignore — его генерирует
 * expo prebuild. Ресурс, положенный туда напрямую, вернул бы дефект при
 * первой же генерации, поэтому исходник живёт в assets/, а в сборку его
 * кладёт post-prebuild-скрипт; проверяются обе половины этого переноса.
 */

import fs from 'fs';
import path from 'path';

import { NOTIFICATION_SMALL_ICON } from '../notificationIcon';

const SRC = path.join(__dirname, '..', '..');
const ROOT = path.join(SRC, '..');
/** Исходник ресурса — единственная его копия под контролем версий. */
const ICON_REL = path.join('assets', 'android', 'res', 'drawable', 'ic_notification.xml');
const ICON_PATH = path.join(ROOT, ICON_REL);
/** Куда его кладёт post-prebuild-скрипт; каталог генерируемый, в git его нет. */
const BUILD_ICON_PATH = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_notification.xml');

const MODULE = fs.readFileSync(path.join(SRC, 'notifications', 'notificationIcon.ts'), 'utf8');
const PREBUILD = fs.readFileSync(path.join(ROOT, 'scripts', 'post-prebuild-android-patches.sh'), 'utf8');

/** Все исходники приложения, кроме тестов, — по ним считаются вызовы notifee. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === '__mocks__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC);

function countAll(needle: string): number {
  return FILES.reduce((sum, file) => sum + (fs.readFileSync(file, 'utf8').split(needle).length - 1), 0);
}

describe('имя ресурса и сам ресурс — одна связь', () => {
  it('константа названа так же, как файл ресурса', () => {
    expect(NOTIFICATION_SMALL_ICON).toBe(path.basename(ICON_REL, '.xml'));
  });

  it('исходник ресурса существует — без него Android отклоняет любое уведомление', () => {
    expect(fs.existsSync(ICON_PATH)).toBe(true);
  });

  it('исходник лежит вне генерируемого android/, иначе prebuild унесёт его с собой', () => {
    expect(ICON_REL.startsWith('assets')).toBe(true);
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toContain('/android');
  });

  it('ресурс — vector drawable, который система примет за small icon', () => {
    const xml = fs.readFileSync(ICON_PATH, 'utf8');
    expect(xml).toContain('<vector');
    expect(xml).toContain('android:width="24dp"');
    expect(xml).toContain('android:height="24dp"');
    expect(xml).toContain('android:viewportWidth="24"');
    expect(xml).toContain('android:viewportHeight="24"');
    expect(xml).toContain('android:pathData=');
  });

  it('силуэт белый и непрозрачный: Android красит small icon сам, цвет из файла не переживёт маску', () => {
    const xml = fs.readFileSync(ICON_PATH, 'utf8');
    expect(xml).toContain('android:fillColor="#FFFFFFFF"');
    expect(xml).not.toContain('gradient');
  });
});

describe('литерал не возвращается в вызовы', () => {
  it('имя ресурса встречается ровно в одном исходнике — в самом модуле', () => {
    const holders = FILES.filter((file) => fs.readFileSync(file, 'utf8').includes("'ic_notification'"));
    expect(holders.map((file) => path.relative(SRC, file))).toEqual([path.join('notifications', 'notificationIcon.ts')]);
  });

  it('модуль ни от чего не зависит и годится для проверки без notifee', () => {
    expect(MODULE.split('\n').filter((line) => line.startsWith('import '))).toEqual([]);
  });
});

describe('каждое уведомление получает small icon', () => {
  it('вызовов notifee, показывающих уведомление, ровно столько же, сколько заданных small icon', () => {
    const shown = countAll('displayNotification(') + countAll('createTriggerNotification(');
    // v4.32.573: седьмой показ — баннер входящего звонка при закрытом приложении.
    // v4.32.558: восьмой — «вам звонили» из журнала непринятых звонков.
    expect(shown).toBe(8);
    expect(countAll('smallIcon: NOTIFICATION_SMALL_ICON')).toBe(shown);
  });

  it('все шесть мест берут имя из модуля, а не пишут своё', () => {
    const importers = FILES.filter((file) => fs.readFileSync(file, 'utf8').includes('NOTIFICATION_SMALL_ICON')).map(
      (file) => path.relative(SRC, file),
    );
    expect(importers.sort()).toEqual(
      [
        'firebaseMessagingBackground.ts',
        path.join('notifications', 'notificationIcon.ts'),
        path.join('notifications', 'pushNotifications.ts'),
        path.join('ui', 'screens', 'ChatScreen.tsx'),
        path.join('ui', 'utils', 'messageReminder.ts'),
      ].sort(),
    );
  });

  it('напоминания больше не ставятся без иконки', () => {
    const reminder = fs.readFileSync(path.join(SRC, 'ui', 'utils', 'messageReminder.ts'), 'utf8');
    expect(reminder).not.toContain('android: { channelId } }');
    expect(reminder).toContain('smallIcon: NOTIFICATION_SMALL_ICON');
  });
});

describe('prebuild не может тихо унести ресурс', () => {
  it('скрипт кладёт ресурс в сборку именно из отслеживаемого исходника', () => {
    expect(PREBUILD).toContain('assets/android/res/drawable/ic_notification.xml');
    expect(PREBUILD).toContain('android/app/src/main/res/drawable');
    expect(PREBUILD).toContain('cp "$ICON_SRC" "$ICON_DST_DIR/ic_notification.xml"');
  });

  it('пропавший исходник останавливает сборку, а не проходит молча', () => {
    expect(PREBUILD).toContain('exit 1');
    expect(PREBUILD.indexOf('ICON_SRC=')).toBeLessThan(PREBUILD.indexOf('echo "[patch] done"'));
  });

  it('если сборка уже сгенерирована, ресурс в ней совпадает с исходником', () => {
    if (!fs.existsSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'res'))) return;
    expect(fs.existsSync(BUILD_ICON_PATH)).toBe(true);
    expect(fs.readFileSync(BUILD_ICON_PATH, 'utf8')).toBe(fs.readFileSync(ICON_PATH, 'utf8'));
  });
});

/**
 * v4.32.593. Марка была перерисована, а этот ресурс — нет: в статус-баре
 * пятьдесят семь версий подряд жил прежний знак, и заметить это можно было
 * только глазами на устройстве. Расхождение возможно потому, что ресурс —
 * пересчёт вектора в 24dp, а не ссылка на него, и связь держалась на памяти.
 * Здесь она держится на арифметике: пересчёт повторяется из того же SVG.
 */
describe('знак в статус-баре — тот же, что в приложении', () => {
  const MARK = fs.readFileSync(path.join(ROOT, 'assets', 'logo', 'airchat-mark.svg'), 'utf8');
  const XML = fs.readFileSync(ICON_PATH, 'utf8');
  /** Габарит чернил в координатах файла — тот же, из которого кадрируется AirChatMark. */
  const INK = { x: 127.4, y: 120, w: 265.5, h: 296 };
  /** 24dp с полем в 1dp сверху и снизу; по горизонтали знак центрован. */
  const SCALE = 22 / INK.h;
  const OX = (24 - INK.w * SCALE) / 2 - INK.x * SCALE;
  const OY = 1 - INK.y * SCALE;

  const commands = (d: string): string[] => d.match(/[A-Za-z]/g) ?? [];
  const numbers = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

  const svgPaths = [...MARK.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  const xmlPaths = [...XML.matchAll(/android:pathData="([^"]+)"/g)].map((m) => m[1]);

  it('контуров столько же и обходятся они теми же командами', () => {
    expect(xmlPaths).toHaveLength(svgPaths.length);
    xmlPaths.forEach((d, index) => {
      expect(commands(d)).toEqual(commands(svgPaths[index]));
    });
  });

  it('каждая точка — пересчёт точки вектора, а не нарисованная заново', () => {
    xmlPaths.forEach((d, index) => {
      const from = numbers(svgPaths[index]);
      const to = numbers(d);
      expect(to).toHaveLength(from.length);
      for (let i = 0; i < from.length; i += 2) {
        expect(to[i]).toBeCloseTo(from[i] * SCALE + OX, 2);
        expect(to[i + 1]).toBeCloseTo(from[i + 1] * SCALE + OY, 2);
      }
    });
  });

  it('дырка реплики выживает на 24dp — иначе знак был бы сплошным пятном', () => {
    // Внутренний контур обходится в обратную сторону: дырку делает правило
    // nonzero, оно же по умолчанию, поэтому fillType здесь намеренно не задан.
    expect(XML).not.toContain('android:fillType');
    const outer = xmlPaths[0];
    const subpaths = outer.split('M').filter((part) => part.trim().length > 0);
    expect(subpaths).toHaveLength(2);
    const width = (d: string): number => {
      const xs = numbers(d).filter((_, i) => i % 2 === 0);
      return Math.max(...xs) - Math.min(...xs);
    };
    // Прежний знак терял на этом размере кольцо: его дырка уходила под 2dp.
    // У реплики она шире половины иконки, и на mdpi силуэт остаётся собой.
    expect(width(subpaths[1])).toBeGreaterThan(12);
    expect(width(subpaths[1])).toBeLessThan(width(subpaths[0]));
  });
});
