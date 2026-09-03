/**
 * Уведомления в браузере включает человек, а не запуск страницы (v4.32.561).
 *
 * Web Push — это резерв на случай, когда ни FCM, ни APNs недоступны: страница
 * подписывается сама, а сервер шлёт пустой пуш (см. signaling-server/webpush.js
 * и web/shims/firebase-messaging). Но у брaузеров разрешение спрашивают иначе,
 * чем у телефона: Safari — а это единственный путь к уведомлениям на iPhone
 * без App Store — отдаёт Push API только в ответ на жест человека, и запрос
 * при старте страницы там просто отклоняется. Поэтому запрос переехал в
 * настройки, под нажатие.
 *
 * Заодно закрыто соседнее следствие того же места: раньше getToken() стоял в
 * init без обёртки, и если он бросал (нет разрешения в браузере, нет Play
 * Services на телефоне), то обрывался ВЕСЬ init — обработчики нажатий по
 * баннеру не ставились вовсе, хотя к push они отношения не имеют.
 *
 * Само поведение подписки проверено в web/shims/__tests__ — здесь проверяется
 * порядок вызовов в приложении, который иначе виден только на устройстве.
 */
import * as fs from 'fs';
import * as path from 'path';

const PUSH = fs.readFileSync(path.join(__dirname, '..', 'pushNotifications.ts'), 'utf8');
const SETTINGS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'ui', 'screens', 'SettingsScreen.tsx'),
  'utf8'
);

/** Кусок исходника между двумя маяками — чтобы проверки не ловили чужие места. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const INIT = between(PUSH, 'private async initLocked', 'this.unsubOnMessage = messaging().onMessage');
const ENABLE = between(PUSH, 'async enableWebPush()', 'async disableWebPush()');
const DISABLE = between(PUSH, 'async disableWebPush()', 'async webPushGranted()');
const REGISTER = between(PUSH, 'async registerTokenWithSignaling', 'async enableWebPush()');

describe('запуск не спрашивает разрешение у браузера', () => {
  it('на вебе init только смотрит уже выданное разрешение', () => {
    expect(INIT).toMatch(/if \(Platform\.OS === 'web'\) \{\s*\n\s*granted = \(await messaging\(\)\.hasPermission\(\)\) === authorized;/);
  });

  it('на телефоне init по-прежнему просит разрешение сам', () => {
    expect(INIT).toMatch(/\} else \{\s*\n\s*await messaging\(\)\.requestPermission\(\);/);
  });

  it('токен берут только с разрешением', () => {
    expect(INIT).toMatch(/if \(granted\) \{\s*\n\s*const token = await messaging\(\)\.getToken\(\);/);
  });

  it('отсутствие токена не обрывает остальную подготовку', () => {
    expect(INIT).toMatch(/try \{[\s\S]*getToken\(\)[\s\S]*\} catch \(e\) \{\s*\n\s*log\.warn\('push_token_unavailable'/);
  });

  it('личность запомнена до похода за токеном — иначе её некому передать', () => {
    expect(INIT.indexOf('this.currentPeerId = options.peerId;')).toBeGreaterThan(-1);
    expect(INIT.indexOf('this.currentPeerId = options.peerId;')).toBeLessThan(
      INIT.indexOf('await messaging().getToken()')
    );
  });
});

describe('включение по нажатию', () => {
  it('только на вебе', () => {
    expect(ENABLE).toContain("if (Platform.OS !== 'web') return 'unsupported';");
  });

  it('без личности в браузер не ходим — записывать подписку было бы некуда', () => {
    const peer = ENABLE.indexOf('const peerId = this.currentPeerId;');
    expect(peer).toBeGreaterThan(-1);
    expect(ENABLE.indexOf("if (!peerId) return 'failed';")).toBeGreaterThan(peer);
    expect(ENABLE.indexOf("if (!peerId) return 'failed';")).toBeLessThan(
      ENABLE.indexOf('requestPermission()')
    );
  });

  it('спрашивает разрешение и на отказе не выдумывает токен', () => {
    expect(ENABLE).toContain("if ((await messaging().requestPermission()) !== authorized) return 'denied';");
    expect(ENABLE.indexOf('requestPermission()')).toBeLessThan(ENABLE.indexOf('getToken()'));
  });

  it('подписку отдаёт сигналингу — иначе будить нас некому', () => {
    expect(ENABLE).toContain('await this.registerTokenWithSignaling(peerId, token);');
    expect(ENABLE).toContain("return 'enabled';");
  });

  it('сбой виден вызывающему, а не молчит', () => {
    expect(ENABLE).toMatch(/catch \(e\) \{[\s\S]*log\.warn\('push_web_enable_failed'[\s\S]*return 'failed';/);
  });

  it('сигналинг принимает веб наравне с телефоном', () => {
    expect(REGISTER).toContain("Platform.OS !== 'web'");
  });
});

describe('выключение', () => {
  it('отписывает браузер', () => {
    expect(DISABLE).toContain('await messaging().deleteToken();');
    expect(DISABLE).toContain('SecureStore.deleteItemAsync(FCM_TOKEN_KEY)');
  });

  it('мёртвую подписку сервер выбросит сам — обещать снятие разрешения нечем', () => {
    expect(PUSH).toContain('Снять само разрешение страница не может');
    expect(PUSH).toContain('410 Gone');
  });
});

describe('переключатель в настройках', () => {
  const ROW = between(SETTINGS, 'Уведомления в браузере', '</View>\n        ) : null}');

  it('показан только на вебе', () => {
    const start = SETTINGS.lastIndexOf("Platform.OS === 'web' ? (", SETTINGS.indexOf('Уведомления в браузере'));
    expect(start).toBeGreaterThan(-1);
  });

  it('включает и выключает через сервис, а не мимо него', () => {
    expect(ROW).toContain('pushNotificationService.enableWebPush()');
    expect(ROW).toContain('pushNotificationService.disableWebPush()');
  });

  it('положение берёт из уже выданного разрешения', () => {
    expect(SETTINGS).toContain('pushNotificationService.webPushGranted().then(setWebPushOn)');
  });

  it('отказ и сбой человек видит строкой — Alert на вебе пустышка', () => {
    expect(ROW).toContain('Браузер отказал');
    expect(ROW).toContain('Не удалось подписаться');
    expect(ROW).not.toContain('Alert.alert');
  });

  it('честно предупреждает про iPhone: без домашнего экрана уведомлений нет', () => {
    expect(ROW).toContain('добавлена на домашний экран');
  });
});
