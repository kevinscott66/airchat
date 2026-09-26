/**
 * v4.32.869. Смена пароля запирала копию в облаке, и сказать об этом было
 * некому.
 *
 * Дефект. Ключ облачного архива выводится из секретных слов И пароля
 * приложения (`deriveCloudKey`) — нужны оба. Сменили пароль — прежняя копия
 * перестала открываться. Ровно та же беда, что у привязки к Apple ID, где для
 * неё с v4.32.615 есть состояние «устарела», — но у облачной копии не было
 * даже отметки «копия отправлена»: настройки помнили только, настроен ли
 * сервер. Предупреждать было нечем и не о чем.
 *
 * Цена. Копия проверяется один раз — на новом телефоне, когда старого уже нет.
 * Там `restoreCloudVault` отвечает «Неверный облачный пароль или повреждённая
 * копия», и человек, который всё сделал правильно и копию отправил, остаётся
 * без аккаунта. Причём отправлял он её как раз затем, чтобы этого не случилось.
 *
 * Правка. Заведена подсказка о копии — три состояния, как у привязки
 * (`backup/cloudVaultCopy`), — и общий адрес на все копии, запертые паролем:
 * `markPasswordBoundCopiesStale`. Оба пути смены пароля зовут его, текст
 * собирает `passwordChangeAftermathText`. Список копий в одном месте: третья,
 * если заведётся, не будет забыта ни одним из путей.
 */
import fs from 'fs';
import path from 'path';

import {
  CLOUD_VAULT_COPY_KEY,
  CLOUD_VAULT_COPY_STORED,
  CLOUD_VAULT_STALE_TEXT,
  cloudCopyAfterPasswordChange,
  markCloudVaultCopyStale,
  parseCloudVaultCopyHint,
  readCloudVaultCopy,
  storeCloudVaultCopy,
} from '../../../core/backup/cloudVaultCopy';
import { APPLE_BINDING_STALE_TEXT } from '../../../core/security/appleBindingStale';
import { passwordChangeAftermathText } from '../../../core/security/passwordChangeAftermath';
import { scopedKvSetChecked, scopedKvTryGet } from '../../../core/storage/profileScopedKv';

jest.mock('../../../core/storage/profileScopedKv', () => ({
  scopedKvTryGet: jest.fn(),
  scopedKvSetChecked: jest.fn(),
}));

// v4.32.977: подсказку читает форма с тремя ответами. `{ value }` — прочитали
// (внутри может быть и null: ячейки нет), голый `null` — прочитать не вышло.
const kvGet = scopedKvTryGet as jest.MockedFunction<typeof scopedKvTryGet>;
/** «Прочитали, и там лежит вот это». */
const answers = (raw: string | null): void => { kvGet.mockResolvedValue({ value: raw }); };
const kvSet = scopedKvSetChecked as jest.MockedFunction<typeof scopedKvSetChecked>;

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

beforeEach(() => {
  kvGet.mockReset();
  kvSet.mockReset();
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('подсказка читается и пишется под своим ключом', async () => {
    answers(CLOUD_VAULT_COPY_STORED.uploaded);
    await expect(readCloudVaultCopy()).resolves.toBe('uploaded');
    expect(kvGet).toHaveBeenCalledWith(CLOUD_VAULT_COPY_KEY);
    kvSet.mockResolvedValue(true);
    await expect(storeCloudVaultCopy('uploaded')).resolves.toBe(true);
    expect(kvSet).toHaveBeenCalledWith(CLOUD_VAULT_COPY_KEY, CLOUD_VAULT_COPY_STORED.uploaded);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ключ копии по-прежнему выводится из пароля вместе со словами', () => {
    const vault = codeOnly(read('core', 'backup', 'cloudVault.ts'));
    expect(vault).toContain(
      'function deriveCloudKey(mnemonic: string, password: string, salt: Uint8Array, iters: number)',
    );
    expect(vault).toContain('const seedKey = deriveLocalDekFromMnemonic(mnemonic);');
    expect(vault).toContain('material.set(passwordBytes, seedKey.length);');
  });

  it('на чужом телефоне отказ уже необратим — там об этом говорят так', () => {
    expect(codeOnly(read('core', 'backup', 'cloudVault.ts'))).toContain(
      "throw new Error('Неверный облачный пароль или повреждённая копия.');",
    );
  });

  it('копия шифруется тем самым паролем приложения, и так и написано', () => {
    expect(SETTINGS()).toContain('await uploadCloudVault(mnemonic, cloudPasswordInput);');
    expect(SETTINGS()).toContain('const unlocked = await unlockSensitiveAccess(cloudPasswordInput);');
  });
});

describe('подсказка о копии: три состояния', () => {
  it('разбор и запись обратны друг другу, незнакомое — «копии нет»', () => {
    for (const h of ['uploaded', 'stale', 'none'] as const) {
      expect(parseCloudVaultCopyHint(CLOUD_VAULT_COPY_STORED[h])).toBe(h);
    }
    for (const raw of [null, undefined, '', '2', 'STALE', ' 1']) {
      expect(parseCloudVaultCopyHint(raw)).toBe('none');
    }
  });

  it('смена пароля трогает только живую копию', () => {
    expect(cloudCopyAfterPasswordChange('uploaded')).toBe('stale');
    expect(cloudCopyAfterPasswordChange('stale')).toBeNull();
    expect(cloudCopyAfterPasswordChange('none')).toBeNull();
  });

  it('копия живая — помечает и говорит «пометили»', async () => {
    answers(CLOUD_VAULT_COPY_STORED.uploaded);
    kvSet.mockResolvedValue(true);
    await expect(markCloudVaultCopyStale()).resolves.toBe('marked');
    expect(kvSet).toHaveBeenCalledWith(CLOUD_VAULT_COPY_KEY, CLOUD_VAULT_COPY_STORED.stale);
  });

  it('копии не было или её уже пометили — не пишет вовсе', async () => {
    for (const stored of [CLOUD_VAULT_COPY_STORED.none, CLOUD_VAULT_COPY_STORED.stale, null]) {
      answers(stored);
      await expect(markCloudVaultCopyStale()).resolves.toBe('not_bound');
    }
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('отказ записи — «не легло», отказ чтения — «неизвестно», и ни одного броска', async () => {
    answers(CLOUD_VAULT_COPY_STORED.uploaded);
    kvSet.mockResolvedValue(false);
    await expect(markCloudVaultCopyStale()).resolves.toBe('unwritten');
    kvSet.mockRejectedValue(new Error('database is locked'));
    await expect(markCloudVaultCopyStale()).resolves.toBe('unwritten');
    kvGet.mockRejectedValue(new Error('database is locked'));
    await expect(markCloudVaultCopyStale()).resolves.toBe('unknown');
  });

  it('нечитаемая подсказка не выдаёт себя за «копии нет»', async () => {
    kvGet.mockRejectedValue(new Error('database is locked'));
    await expect(readCloudVaultCopy()).resolves.toBeNull();
  });
});

describe('текст про запертые копии', () => {
  it('молчит, когда копий не было', () => {
    expect(passwordChangeAftermathText({ apple: 'not_bound', cloud: 'not_bound' })).toBeNull();
    expect(passwordChangeAftermathText({ apple: 'unknown', cloud: 'unknown' })).toBeNull();
  });

  it('называет ровно те копии, которые заперты', () => {
    expect(passwordChangeAftermathText({ apple: 'marked', cloud: 'not_bound' })).toBe(
      APPLE_BINDING_STALE_TEXT.marked,
    );
    expect(passwordChangeAftermathText({ apple: 'not_bound', cloud: 'marked' })).toBe(
      CLOUD_VAULT_STALE_TEXT.marked,
    );
  });

  it('заперты обе — обе и названы, каждая со своим действием', () => {
    const both = passwordChangeAftermathText({ apple: 'marked', cloud: 'unwritten' });
    expect(both).toContain('привяжите слова заново');
    expect(both).toContain('Отправьте её заново сейчас');
    expect(both?.split('\n\n')).toHaveLength(2);
  });

  it('«не легло» говорит, что настройки соврут после перезапуска', () => {
    expect(CLOUD_VAULT_STALE_TEXT.unwritten).toContain('после перезапуска');
    expect(CLOUD_VAULT_STALE_TEXT.marked).not.toBe(CLOUD_VAULT_STALE_TEXT.unwritten);
  });
});

describe('настройки помнят копию и говорят о ней', () => {
  it('удачная отправка отмечается, иначе сказано прямо', () => {
    const s = SETTINGS();
    const at = s.indexOf('await uploadCloudVault(mnemonic, cloudPasswordInput);');
    expect(at).toBeGreaterThan(0);
    const body = s.slice(at, at + 700);
    expect(body).toContain("setCloudCopy('uploaded');");
    expect(body).toContain("const remembered = await storeCloudVaultCopy('uploaded');");
    // Про незаписанную отметку говорят: молчание тут означает потерянную копию.
    expect(body).toContain('при смене пароля приложение не сможет предупредить');
    // Отметка на экране стоит до записи и от её исхода не зависит.
    expect(body.indexOf("setCloudCopy('uploaded');")).toBeLessThan(
      body.indexOf("const remembered = await storeCloudVaultCopy('uploaded');"),
    );
  });

  it('строка в списке различает «копия есть» и «копия устарела»', () => {
    const s = SETTINGS();
    expect(s).toContain("cloudCopy === 'stale'");
    expect(s).toContain('Прежняя копия не откроется нынешним паролем — отправьте заново');
    expect(s).toContain("cloudCopy === 'uploaded'");
    // Нечитаемая подсказка (`null`) не обещает ничего — падает в общий текст.
    expect(s).toContain('Зашифровать паролем приложения и отправить');
  });

  it('подсказка читается при открытии, и отказ не выдаёт себя за «копии нет»', () => {
    expect(SETTINGS()).toContain('void readCloudVaultCopy().then(setCloudCopy);');
    expect(SETTINGS()).toContain("const [cloudCopy, setCloudCopy] = useState<CloudVaultCopyHint | null>(null);");
  });

  it('ключ подсказки один на приложение', () => {
    const holders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(full); }
        else if (/\.tsx?$/.test(e.name) && fs.readFileSync(full, 'utf8').includes("'cloud_vault_copy_v1'")) {
          holders.push(path.relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(holders).toEqual([path.join('core', 'backup', 'cloudVaultCopy.ts')]);
  });
});
