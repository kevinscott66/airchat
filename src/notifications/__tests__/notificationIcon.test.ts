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
    expect(shown).toBe(7);
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
