/**
 * Непрочитанные названия папок выдавались за «папок нет» (v4.32.1067).
 *
 * ДЕФЕКТ. Названия папок лежат одной шифрованной записью профиля. Читать её
 * умеет не получиться, и чтение исходом (`tryReadProfileSharedSecret`) об этом
 * говорит с v4.32.699 — тогда же запись перестала принимать непрочитанный
 * набор за пустой, иначе переименование одной папки стирало все остальные.
 * Рядом с честным чтением стояла собирающая форма — `loadFolderNames`, «не
 * прочитали → {}», — и шапка списка переписок звала именно её. Пустой набор
 * значит там «папок нет»: это утверждение, а не молчание.
 *
 * ЦЕНА. Две беды, и обе тихие.
 *
 * Первая: вкладки папок исчезают. Отметка на переписке при этом цела — она
 * лежит отдельной записью, — а вкладки строятся по названиям. Хуже того,
 * список перечитывается по `refreshTick`, то есть уже с выбранной вкладкой
 * папки: фильтр остаётся включённым, вкладки под него нет, и список выглядит
 * опустевшим без единого слова о том, почему.
 *
 * Вторая: окно цветной метки у метки без названия предлагает «Создать папку с
 * этой меткой». Не прочитав набор, мы не знаем, есть ли она. Человек
 * соглашается, набирает имя — и `setFolderName` перечитывает набор сам (там
 * это исправлено), так что при удавшемся чтении запись ложится поверх
 * существующей папки. Прежнего названия он не видел ни разу и не узнает, что
 * оно было.
 *
 * ПРАВКА. Звать `tryReadFolderNames` и держать `null` отдельно от пустого
 * набора. Прочитанное прежде не затираем — оно было правдой (тот же принцип,
 * что у списка переписок с v4.32.622). Под вкладками — строка о том, что
 * названия не прочитались, а папки целы. В окне метки третий ответ вместо
 * предложения создать папку.
 *
 * ГРАНИЦЫ. Пустой набор после удачного чтения — по-прежнему «папок нет»: ни
 * строки, ни оговорки. Отсутствие записи — тоже удачное чтение (первый
 * запуск). Название, прочитанное раньше, важнее нынешнего незнания:
 * переименование и без того перечитывает набор перед записью. Правку не
 * запрещаем — запись сама откажется и скажет словами (v4.32.904).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  folderTagAction,
  FOLDER_TAG_UNKNOWN_HINT,
  FOLDERS_UNREAD_NOTE,
} from '../../utils/folderNamesUnread';

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const read = (...rel: string[]): string =>
  codeOnly(readFileSync(join(__dirname, '..', '..', '..', ...rel), 'utf8'));

const SCREEN = (): string => read('ui', 'screens', 'ChatListScreen.tsx');
const STORE = (): string => read('core', 'storage', 'chatFolders.ts');

describe('что предложить для цветной метки', () => {
  it('название прочитано — переименовать', () => {
    expect(folderTagAction(true, false)).toBe('rename');
  });

  it('набор прочитан, названия у метки нет — создать', () => {
    expect(folderTagAction(false, false)).toBe('create');
  });

  it('набор не прочитан — не знаем, и создавать не предлагаем', () => {
    // Ровно та развилка, ради которой всё: предложить создание значит
    // утверждать, что папки нет, а мы её просто не видели.
    expect(folderTagAction(false, true)).toBe('unknown');
  });

  it('ГРАНИЦА: прочитанное название важнее нынешнего незнания', () => {
    expect(folderTagAction(true, true)).toBe('rename');
  });
});

describe('слова', () => {
  it('под вкладками сказано и про вкладки, и про то, что папки целы', () => {
    // Без второй половины вывод из исчезнувших вкладок один — «папки
    // пропали», — и человек заводит их заново поверх существующих.
    expect(FOLDERS_UNREAD_NOTE).toContain('не прочитались');
    expect(FOLDERS_UNREAD_NOTE).toContain('Сами папки на месте');
    expect(FOLDERS_UNREAD_NOTE).toContain('откройте список ещё раз');
    // У этого экрана нет тяги вниз: звать потянуть список нечем.
    expect(FOLDERS_UNREAD_NOTE).not.toContain('отяните');
  });

  it('в окне метки сказано именно про незнание, а не про отсутствие папки', () => {
    expect(FOLDER_TAG_UNKNOWN_HINT).toContain('не прочитались');
    expect(FOLDER_TAG_UNKNOWN_HINT).not.toContain('Создать');
  });
});

describe('форма исходника списка переписок', () => {
  it('названия читаются исходом, а не собирающей формой', () => {
    const s = SCREEN();
    expect(s).toContain('void tryReadFolderNames().then((names) => {');
    expect(s).not.toContain('loadFolderNames(');
  });

  it('«не прочитали» живёт отдельно от самого набора', () => {
    const s = SCREEN();
    expect(s).toContain('const [folderNamesUnread, setFolderNamesUnread] = useState(false);');
    expect(s).toContain('setFolderNamesUnread(names === null);');
  });

  it('прочитанное прежде не затирается непрочитанным ответом', () => {
    const s = SCREEN();
    // Не `setFolderNames(names ?? {})`: удачное чтение было правдой, и терять
    // его из-за следующего отказа незачем.
    expect(s).toContain('if (names) setFolderNames(names);');
    expect(s).not.toContain('setFolderNames(names ?? {})');
  });

  it('оба места спрашивают правило, а не решают на глаз', () => {
    const s = SCREEN();
    expect(s).toContain("folderNamesUnread) === 'create' ? (");
    expect(s).toContain("folderNamesUnread) === 'unknown' ? (");
    expect(s.match(/folderTagAction\(/g)?.length).toBe(2);
  });

  it('обе строки показаны янтарём — вторым сигналом, а не обычной подписью', () => {
    const s = SCREEN();
    for (const id of ['chat_list_folders_unread_note', 'chat_list_folder_tag_unknown']) {
      const at = s.indexOf(`testID="${id}"`);
      expect([id, at > 0]).toEqual([id, true]);
      expect([id, s.slice(at - 260, at).includes('colors.warning')]).toEqual([id, true]);
    }
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежнее поведение шапки цело', () => {
  it('вкладки папок всё так же строятся по прочитанным названиям', () => {
    const s = SCREEN();
    expect(s).toContain('...Object.entries(folderNames).map(([color, name]) => ({');
  });

  it('переименование и создание папки на месте', () => {
    const s = SCREEN();
    expect(s).toContain('Создать папку с этой меткой');
    expect(s).toContain('Переименовать папку');
  });

  it('отказ записи по-прежнему назван словами (v4.32.904)', () => {
    const s = SCREEN();
    expect(s).toContain("res.why === 'unreadable' ? 'Не удалось прочитать названия папок'");
  });
});

describe('форма исходника хранилища', () => {
  it('чтение отдано наружу и отвечает «не прочитали»', () => {
    const s = STORE();
    expect(s).toContain('export async function tryReadFolderNames(): Promise<FolderNames | null> {');
    expect(s).toContain('return read === null ? null : parseFolderNames(read.value);');
  });

  it('собирающей формы рядом не осталось — звать обратно нечего', () => {
    expect(STORE()).not.toContain('export async function loadFolderNames');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('запись тот же ответ различает с v4.32.699', () => {
    // Про смысл, а не про написание: как бы ни звалось чтение, отказ базы
    // обязан доходить до записи отдельным ответом.
    const s = STORE();
    expect(s).toContain('if (current === null) {');
    expect(s).toContain("return { ok: false, why: 'unreadable', names: null };");
  });

  it('удачное чтение отсутствующей записи — это пустой набор, а не отказ', () => {
    // Иначе первый запуск показывал бы строку о непрочитанных названиях.
    const s = STORE();
    const at = s.indexOf('function parseFolderNames(');
    expect(at).toBeGreaterThan(0);
    expect(s.slice(at, at + 200)).toContain('return {};');
  });
});

describe('ЗАКРЕПКА', () => {
  it('правило лежит отдельно от экрана и без импортов', () => {
    const rule = readFileSync(join(__dirname, '..', '..', 'utils', 'folderNamesUnread.ts'), 'utf8');
    expect(codeOnly(rule)).not.toContain('import ');
  });
});
