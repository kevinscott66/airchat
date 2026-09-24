/**
 * «Новый чат» перестал просить то, чего не умеет (v4.32.891).
 *
 * Дефект. Окно добавления собеседника состояло из трёх полей. Два первых
 * написаны по-человечески: «Ссылка или код собеседника», «Имя
 * (необязательно)». Третье называлось «CID профиля в облаке (необязательно)»
 * и подсказывало «Qm… или baf…».
 *
 * Дело даже не в словах. Это поле не могло сработать ни у кого:
 *
 *   1. Единственным читателем записанного значения был
 *      `syncDmHistoryFromProfile`: он берёт карточку через `fetchProfileByCid`,
 *      то есть через IPFS, а тот на телефоне выключен наглухо с v4.32.19 —
 *      `catFromIpfs` возвращает null не начиная работы.
 *   2. Даже там, где IPFS включён, искать в карточке нечего: нужный
 *      `conversationTips` перестали в неё класть в v4.32.291, и в исходниках
 *      не осталось ни одного места, которое его пишет.
 *   3. Писало это значение ровно одно окно — то самое. Остальные три вызова
 *      `addContact` его не передают.
 *
 * Цена. Треть главного окна знакомства занимала просьба, которую обычный
 * человек не может понять, а понявший — выполнить с пользой. Введённое
 * ложилось в базу и не читалось никогда.
 *
 * Правка. Поле убрано. Провод `addContact(..., profileCid?)` и разбор старых
 * строк оставлены как есть: они не видны человеку, и трогать их — отдельная
 * работа с другой ценой ошибки.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');

/** Только код: комментарий, где написано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const code = (...parts: string[]): string =>
  codeOnly(fs.readFileSync(path.join(SRC, ...parts), 'utf8'));

/** Вырезка окна «Новый чат» — от его объявления до следующего за ним. */
function addContactModal(): string {
  const s = code('ui', 'screens', 'ChatListScreen.tsx');
  const from = s.indexOf('function AddContactModal({');
  const to = s.indexOf('const acStyles = StyleSheet.create({');
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return s.slice(from, to);
}

/** Все файлы с исходниками — чтобы спрашивать о дереве, а не об одном месте. */
function allSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

describe('окно знакомства спрашивает только то, что человек может дать', () => {
  it('поля «CID профиля в облаке» больше нет', () => {
    const modal = addContactModal();
    expect(modal).not.toContain('CID профиля в облаке');
    expect(modal).not.toContain('Qm… или baf…');
    expect(modal).not.toContain('profileCid');
  });

  it('состояние под него и очистка этого состояния убраны заодно', () => {
    const modal = addContactModal();
    expect(modal).not.toContain('setProfileCid');
    expect(modal).toContain("const reset = () => { setKeyInput(''); setNameInput(''); };");
  });

  it('контакт заводится тремя доводами — четвёртому неоткуда взяться', () => {
    const modal = addContactModal();
    expect(modal).toContain('await addContact(pair, pk, name);');
  });

  it('в окне осталось ровно два поля ввода', () => {
    const modal = addContactModal();
    expect(modal.split('<TextInput').length - 1).toBe(2);
    expect(modal).toContain('Ссылка или код собеседника');
    expect(modal).toContain('Имя (необязательно)');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: значение было некому прочитать', () => {
  it('единственный читатель ходит за карточкой в выключенный IPFS', () => {
    const sync = code('core', 'social', 'messageSync.ts');
    expect(sync).toContain('const profileCid = await getContactProfileCid(peerPublicKeyB64);');
    expect(sync).toContain('const profile = await fetchProfileByCid(profileCid);');
    const profile = code('core', 'identity', 'profile.ts');
    expect(profile).toContain('const merged = await catFromIpfs(cid);');
    const ipfs = code('core', 'transport', 'ipfs', 'node.ts');
    expect(ipfs).toContain('if (!isIpfsEnabled()) return null;');
    const helia = code('core', 'transport', 'ipfs', 'heliaNode.ts');
    // Телефон — это android и ios, и ровно им отвечают «выключено».
    expect(helia).toContain("if (Platform.OS !== 'android' && Platform.OS !== 'ios') return true;");
    expect(helia).toContain('  return false;\n}');
  });

  it('и даже при включённом IPFS в карточке нечего искать: `conversationTips` никто не пишет', () => {
    const writers = allSources().filter((file) => {
      const s = codeOnly(fs.readFileSync(file, 'utf8'));
      // Запись — это присваивание поля, а не чтение `?.conversationTips`.
      return /conversationTips\s*[:=]/.test(s) && !/\?\.conversationTips/.test(s);
    });
    // Остаются только объявление поля в типе и его вычистка при разборе
    // чужой карточки — оба в identity/profile.ts, оба про чтение.
    expect(writers.map((f) => path.relative(SRC, f))).toEqual([
      path.join('core', 'identity', 'profile.ts'),
    ]);
    const profile = code('core', 'identity', 'profile.ts');
    expect(profile).toContain('conversationTips?: Record<string, string>;');
    expect(profile).toContain('safe.conversationTips = tips;');
    // v4.32.291: в подписываемую карточку список подсказок больше не кладут.
    expect(profile).not.toContain('conversationTips: tips,');
  });

  it('писало это значение одно окно, и это было оно', () => {
    const callers = allSources().filter((file) => /\baddContact\(pair/.test(fs.readFileSync(file, 'utf8')));
    expect(callers.length).toBeGreaterThanOrEqual(3);
    for (const file of callers) {
      const s = codeOnly(fs.readFileSync(file, 'utf8'));
      expect(s).not.toMatch(/addContact\(pair,[^)]*,[^)]*,[^)]*\)/);
    }
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: знакомство осталось знакомством', () => {
  it('ссылка по-прежнему разбирается, а непонятная — отвергается словами', () => {
    const modal = addContactModal();
    expect(modal).toContain('const pk = parseContactId(key);');
    expect(modal).toContain('Это не похоже на ссылку или код AirChat. Попросите прислать их заново.');
    expect(modal).toContain('Вставьте ссылку или код собеседника');
  });

  it('себя в контакты и дубликат по-прежнему не пропускают', () => {
    const modal = addContactModal();
    expect(modal).toContain('Нельзя добавить самого себя как контакт');
    expect(modal).toContain('Контакт уже добавлен');
    expect(modal).toContain('уже в списке контактов. Открыть чат или удалить его?');
  });

  it('после добавления всё так же обновляются подписки и подтягивается история', () => {
    const modal = addContactModal();
    expect(modal).toContain('await getMessagingService()?.refreshSubscriptions();');
    expect(modal).toContain('await getMessagingService()?.syncHistoryFromPeer(pkB64, 100);');
    expect(modal).toContain("showSuccess('Контакт добавлен');");
    expect(modal).toContain("const name = nameInput.trim() || 'Новый контакт';");
  });

  it('отказ базы по-прежнему называется человеческими словами', () => {
    const modal = addContactModal();
    expect(modal).toContain("showError(userErrorText(e, 'Не удалось добавить контакт'));");
    expect(modal).toContain("showError(userErrorText(e, 'Не удалось удалить контакт'));");
  });
});
