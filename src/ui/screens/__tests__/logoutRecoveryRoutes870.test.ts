/**
 * v4.32.870. Подтверждение выхода обещало копию, которой могло не быть.
 *
 * Дефект. Текст был один на всех: «Удалить секретные слова и все локальные
 * данные на этом устройстве? Восстановление будет возможно только из
 * сохранённой копии слов». Для того, кто на заведении аккаунта выбрал «Сделаю
 * позже», сохранённой копии не существует — и экран об этом знал: строкой выше
 * у него же написано «Секретные слова не проверены». Обе копии, запертые сменой
 * пароля (v4.32.868, v4.32.869), текст не различал тем более.
 *
 * Цена. Выход стирает с устройства всё: слова, ключи, переписку. Обратного хода
 * нет, и проверить обещание человек может только после того, как согласится.
 * Фраза про «сохранённую копию» читается как подтверждение, что копия есть, —
 * то есть ровно как разрешение нажать.
 *
 * Правка. Пути назад считает `core/security/recoveryRoutes`: записанные слова,
 * конверт у Apple ID, архив в облаке. Живой путь называют, устаревшую копию
 * называют отдельно — её ещё можно починить, пока слова на устройстве, — а
 * непрочитанное состояние не обещает ничего. Заодно `seedBackupPending` стал
 * трёхзначным: отказ хранилища отвечал `false`, самым успокаивающим из
 * возможных ответов.
 */
import fs from 'fs';
import path from 'path';

import {
  liveRecoveryRoutes,
  logoutConfirmText,
  staleRecoveryRoutes,
} from '../../../core/security/recoveryRoutes';
import type { RecoveryOutlook } from '../../../core/security/recoveryRoutes';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const SETTINGS = (): string => codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));

/** Ничего не известно и ничего нет — с этого начинается каждый случай. */
const BLANK: RecoveryOutlook = { wordsVerified: null, apple: null, cloud: null };

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('подтверждение выхода по-прежнему одно и стоит на кнопке выхода', () => {
    const s = SETTINGS();
    expect(s).toContain("const confirmLogout = useCallback(() => {");
    expect(s).toContain("'Выйти из аккаунта',");
    expect(s).toContain("text: 'Удалить и выйти',");
    expect(s).toContain('onPress={confirmLogout}');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('отложенную запись слов экран знает и сам о ней пишет', () => {
    const s = SETTINGS();
    expect(s).toContain('const [seedBackupPending, setSeedBackupPendingState]');
    expect(s).toContain('Секретные слова не проверены');
    expect(s).toContain('Без записанных слов аккаунт не восстановить.');
  });

  it('выход действительно стирает всё — это не обратимое действие', () => {
    const s = SETTINGS();
    const at = s.indexOf("text: 'Удалить и выйти',");
    expect(at).toBeGreaterThan(0);
    expect(s.slice(at, at + 260)).toContain("style: 'destructive'");
    expect(s.slice(at, at + 260)).toContain('void onLogout()');
  });

  it('обе копии по-прежнему умеют устаревать от смены пароля', () => {
    expect(codeOnly(read('core', 'security', 'appleBindingHint.ts'))).toContain(
      "export function hintAfterPasswordChange(",
    );
    expect(codeOnly(read('core', 'backup', 'cloudVaultCopy.ts'))).toContain(
      "export function cloudCopyAfterPasswordChange(",
    );
  });
});

describe('живые пути назад', () => {
  it('записанные слова — путь, отложенная запись — нет', () => {
    expect(liveRecoveryRoutes({ ...BLANK, wordsVerified: true })).toEqual(['записанные секретные слова']);
    expect(liveRecoveryRoutes({ ...BLANK, wordsVerified: false })).toEqual([]);
    expect(liveRecoveryRoutes(BLANK)).toEqual([]);
  });

  it('устаревшая копия путём не считается ни одна', () => {
    expect(liveRecoveryRoutes({ ...BLANK, apple: 'stale', cloud: 'stale' })).toEqual([]);
    expect(liveRecoveryRoutes({ ...BLANK, apple: 'bound' })).toEqual(['копию слов у Apple ID']);
    expect(liveRecoveryRoutes({ ...BLANK, cloud: 'uploaded' })).toEqual(['зашифрованную копию в облаке']);
  });

  it('устаревшие названы отдельно: их ещё можно починить', () => {
    expect(staleRecoveryRoutes({ ...BLANK, apple: 'stale', cloud: 'stale' })).toEqual([
      'привязка к Apple ID',
      'копия в облаке',
    ]);
    expect(staleRecoveryRoutes({ ...BLANK, apple: 'bound', cloud: 'uploaded' })).toEqual([]);
  });
});

describe('текст подтверждения выхода', () => {
  it('всегда говорит, что именно исчезнет', () => {
    for (const o of [BLANK, { ...BLANK, wordsVerified: true }, { ...BLANK, wordsVerified: false }]) {
      expect(logoutConfirmText(o)).toContain(
        'Секретные слова и все локальные данные будут удалены с этого устройства.',
      );
    }
  });

  it('пути есть — перечисляет их, и обещания в тексте нет лишнего', () => {
    const t = logoutConfirmText({ wordsVerified: true, apple: 'bound', cloud: 'uploaded' });
    expect(t).toContain(
      'Вернуться в аккаунт можно будет через записанные секретные слова, копию слов у Apple ID и зашифрованную копию в облаке.',
    );
    expect(t).not.toContain('нечем');
  });

  it('единственный путь называется в единственном числе, без «и»', () => {
    const t = logoutConfirmText({ wordsVerified: true, apple: 'none', cloud: 'none' });
    expect(t).toContain('можно будет через записанные секретные слова.');
  });

  it('путей нет и запись отложена — прямая правда и просьба отменить', () => {
    const t = logoutConfirmText({ wordsVerified: false, apple: 'none', cloud: 'none' });
    expect(t).toContain('Вернуться будет нечем');
    expect(t).toContain('запись секретных слов вы отложили и не проверяли');
    expect(t).toContain('Отмените выход');
    // Прежний текст обещал копию — именно это и было неправдой.
    expect(t).not.toContain('из сохранённой копии слов');
  });

  it('копии заперты паролем — сказано именно это, а не «копий нет»', () => {
    const t = logoutConfirmText({ wordsVerified: false, apple: 'stale', cloud: 'stale' });
    expect(t).toContain('привязка к Apple ID не откроется нынешним паролем');
    expect(t).toContain('копия в облаке не откроется нынешним паролем');
    expect(t).toContain('запись секретных слов вы отложили и не проверяли');
  });

  it('ничего не прочиталось — ни обещаний, ни приговора', () => {
    const t = logoutConfirmText(BLANK);
    expect(t).not.toContain('нечем:');
    expect(t).not.toContain('можно будет через');
    expect(t).toContain('Убедитесь, что секретные слова записаны');
  });

  it('неизвестная запись слов при живой копии не мешает назвать копию', () => {
    expect(logoutConfirmText({ ...BLANK, cloud: 'uploaded' })).toContain(
      'можно будет через зашифрованную копию в облаке.',
    );
  });
});

describe('экран спрашивает правду, а не самый удобный ответ', () => {
  it('отказ чтения отметки о словах больше не выдаёт себя за «проверены»', () => {
    const s = SETTINGS();
    expect(s).toContain('useState<boolean | null>(false);');
    expect(s).toContain(
      'void hasSeedBackupPending().then(setSeedBackupPendingState).catch(() => setSeedBackupPendingState(null));',
    );
  });

  it('текст собирается по всем трём свидетелям, какие есть на экране', () => {
    const s = SETTINGS();
    const at = s.indexOf('const confirmLogout = useCallback(');
    const end = s.indexOf('\n  }, [', at);
    expect(end).toBeGreaterThan(at);
    const body = s.slice(at, end);
    expect(body).toContain('wordsVerified: seedBackupPending === null ? null : !seedBackupPending,');
    expect(body).toContain("apple: appleBound ? 'bound' : appleBindStale ? 'stale' : 'none',");
    expect(body).toContain('cloud: cloudCopy,');
    // Своего текста у обработчика не осталось вовсе.
    expect(body).not.toContain('Восстановление будет возможно');
  });

  it('свидетели названы в зависимостях — иначе текст застынет на первом', () => {
    expect(SETTINGS()).toContain(
      '}, [onLogout, logoutBusy, seedBackupPending, appleBound, appleBindStale, cloudCopy]);',
    );
  });

  it('чтение подсказки Apple больше не роняет необработанный отказ', () => {
    const s = SETTINGS();
    const at = s.indexOf('setAppleBindReady(true);');
    expect(at).toBeGreaterThan(0);
    const body = s.slice(at, at + 520);
    expect(body).toContain('hint = parseAppleBindingHint(await scopedKvGet(APPLE_BINDING_HINT_KEY));');
    expect(body).toContain("log.warn('apple_binding_hint_read_failed'");
    // Именно try, а не «тоже где-то рядом»: чтение стоит внутри него.
    expect(body.indexOf('try {')).toBeLessThan(
      body.indexOf('hint = parseAppleBindingHint(await scopedKvGet(APPLE_BINDING_HINT_KEY));'),
    );
  });

  it('старого текста нет нигде в приложении', () => {
    const walk = (dir: string, hits: string[]): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(full, hits); }
        else if (/\.tsx?$/.test(e.name) && fs.readFileSync(full, 'utf8').includes('Восстановление будет возможно только из сохранённой копии слов')) {
          hits.push(path.relative(SRC, full));
        }
      }
      return hits;
    };
    expect(walk(SRC, [])).toEqual([]);
  });
});
