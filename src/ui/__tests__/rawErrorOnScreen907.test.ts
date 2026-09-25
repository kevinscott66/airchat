/**
 * Сырой текст ошибки доходил до экрана (v4.32.907).
 *
 * Дефект. `userErrorText` написан ровно затем, чтобы этого не было, и его
 * докблок говорит прямо: `rawErrorText` — «для журнала, НЕ для экрана».
 * Два места правило обходили.
 *
 *   ContactsScreen, сканер QR:
 *     const msg = e?.message ?? 'camera mount error';
 *     setScannerError(msg);
 *
 *   OnboardingScreen, отмена создания аккаунта:
 *     Alert.alert('AirChat', `Не удалось отменить создание аккаунта: ${rawErrorText(e)}`);
 *
 * Цена. `onMountError` зовёт expo-camera, и пишет она по-английски: поверх
 * видоискателя, между русской подсказкой «QR-код виден на „Профиль → QR-код“»
 * и русской же надписью про разрешение, появлялась строка `Camera is not
 * running`. А если сообщения не было вовсе — `camera mount error`, текст,
 * который мы сами сочинили по-английски для русского экрана.
 *
 * В онбординге хуже: человек только что нажал «Да, назад», аккаунта у него
 * ещё нет, и к русскому началу фразы приклеивался `documentDirectory
 * unavailable`. Начало фразы при этом нужно оставить — без него причина, даже
 * своя и русская, не говорит, ЧТО не вышло.
 *
 * Правка. Экран получает `userErrorText(e, ...)` либо свой текст с причиной,
 * дописанной только если её писали для чтения (`isUserFacingMessage`, как в
 * ленте с v4.32.689). Журнал получает `rawErrorText` — он там и был нужен.
 *
 * Экраны в jest не поднимаются, поэтому места проверяются по исходнику;
 * поведение самого правила — вызовами.
 */
import fs from 'fs';
import path from 'path';
import { isUserFacingMessage, rawErrorText, userErrorText } from '../components/userErrorText';

const SRC = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** Исходник без строк-комментариев: пояснение цитирует те же выражения. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

describe('чужой текст ошибки больше не показывается человеку', () => {
  test('сканер QR берёт текст правилом, а не из e.message', () => {
    const code = codeOnly(SRC('screens/ContactsScreen.tsx'));
    expect(code).toContain(
      "setScannerError(userErrorText(e, 'Не удалось включить камеру'));",
    );
    expect(code).not.toContain("const msg = e?.message ?? 'camera mount error';");
    expect(code).not.toContain('setScannerError(msg);');
  });

  test('журнал сканера по-прежнему получает сырой текст', () => {
    // Разделение и есть правка: одному месту нужен машинный текст, другому нет.
    expect(codeOnly(SRC('screens/ContactsScreen.tsx'))).toContain(
      "log.warn('ui_contacts_scanner_mount_error', { err: rawErrorText(e) });",
    );
  });

  test('английского запасного текста в коде не осталось', () => {
    // В пояснении к правке он назван — там ему и место.
    expect(codeOnly(SRC('screens/ContactsScreen.tsx'))).not.toContain('camera mount error');
  });

  test('отмена создания аккаунта не клеит машинный хвост', () => {
    const code = codeOnly(SRC('screens/OnboardingScreen.tsx'));
    expect(code).toContain('isUserFacingMessage(raw)');
    expect(code).toContain('? `Не удалось отменить создание аккаунта: ${raw}`');
    expect(code).toContain(
      "        : 'Не удалось отменить создание аккаунта. Попробуйте ещё раз.',",
    );
  });

  test('начало фразы осталось в обеих ветках', () => {
    // Своя причина дописывается, чужая заменяется — но «что не вышло» человек
    // читает в любом случае.
    const code = codeOnly(SRC('screens/OnboardingScreen.tsx'));
    const both = code.split('Не удалось отменить создание аккаунта').length - 1;
    expect(both).toBe(2);
  });

  test('онбординг завёл журнальную запись об этом отказе', () => {
    expect(codeOnly(SRC('screens/OnboardingScreen.tsx'))).toContain(
      "log.warn('ui_onboarding_wipe_failed', { err: raw });",
    );
  });

  test('isUserFacingMessage в онбординге импортирован, а не дописан по месту', () => {
    expect(SRC('screens/OnboardingScreen.tsx')).toContain(
      "import { isUserFacingMessage, rawErrorText, userErrorText } from '../components/userErrorText';",
    );
  });

  test('во всём src/ui больше нет чтения e.message мимо правила', () => {
    // Ровно та форма, которой здесь не стало. Единственные законные места —
    // сам модуль userErrorText.
    const dir = path.join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        if (fs.statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(name) || name === 'userErrorText.ts') continue;
        if (/\be\??\.message\s*\?\?/.test(codeOnly(fs.readFileSync(full, 'utf8')))) {
          offenders.push(path.relative(dir, full));
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});

describe('до правки было верно и осталось верно', () => {
  test('правило по-прежнему пропускает наш русский текст', () => {
    expect(userErrorText(new Error('Хранилище недоступно'), 'запасной')).toBe(
      'Хранилище недоступно',
    );
    expect(isUserFacingMessage('Хранилище недоступно')).toBe(true);
  });

  test('правило по-прежнему заменяет чужой английский', () => {
    expect(userErrorText(new Error('Camera is not running'), 'Не удалось включить камеру')).toBe(
      'Не удалось включить камеру',
    );
    expect(isUserFacingMessage('documentDirectory unavailable')).toBe(false);
  });

  test('на ошибке без сообщения берётся запасной текст', () => {
    expect(userErrorText(new Error(''), 'Не удалось включить камеру')).toBe(
      'Не удалось включить камеру',
    );
    expect(userErrorText(undefined, 'Не удалось включить камеру')).toBe(
      'Не удалось включить камеру',
    );
  });

  test('журналу по-прежнему достаётся текст как есть', () => {
    expect(rawErrorText(new Error('Camera is not running'))).toBe('Camera is not running');
  });

  test('сканер по-прежнему говорит про разрешение и подсказку своими словами', () => {
    const code = codeOnly(SRC('screens/ContactsScreen.tsx'));
    expect(code).toContain('Разрешение на камеру не выдано.');
    expect(code).toContain('QR-код виден на «Профиль → QR-код»');
  });
});
