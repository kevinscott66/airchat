/**
 * Рэтчет к v4.32.566: список запланированных сообщений существует одним файлом.
 *
 * До этой версии его было два — `modals/chat/ChatScheduledListModal.tsx` и
 * `modals/groups/GroupScheduledListModal.tsx`, — и `diff` между ними давал
 * четыре строки: имя типа элемента, имя типа пропсов, имя внутренней функции
 * и имя экспорта. Разметка, стили, подтверждение удаления и подпись строки
 * совпадали посимвольно.
 *
 * Проверка здесь — по форме исходников, и иначе быть не может: компонент
 * тянет react-native, AppModal и ThemeContext, то есть в jest не грузится.
 * Зато форма — ровно то, что охраняется: вернуть вторую копию можно только
 * создав файл с прежним именем или добавив второй импорт в экран, и оба
 * действия эти тесты ловят.
 *
 * Почему рэтчет вообще нужен. Расхождение уже стоило правок: v4.32.565
 * вносила одно и то же изменение руками в оба файла, и совпали они лишь
 * потому, что правку делали в один заход. Прежний тест это состояние
 * закреплял («оба списка остались одинаковыми») — то есть охранял дубликат
 * вместо того, чтобы его запрещать. Здесь он развёрнут.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const exists = (...p: string[]) => fs.existsSync(path.join(SRC, ...p));

const SHARED = () => read('ui', 'components', 'modals', 'shared', 'ScheduledListModal.tsx');
const CHAT_SCREEN = () => read('ui', 'screens', 'ChatScreen.tsx');
const GROUPS_SCREEN = () => read('ui', 'screens', 'GroupsScreen.tsx');

describe('список запланированных — один компонент на оба экрана', () => {
  it('прежних двух копий больше нет', () => {
    expect(exists('ui', 'components', 'modals', 'chat', 'ChatScheduledListModal.tsx')).toBe(false);
    expect(exists('ui', 'components', 'modals', 'groups', 'GroupScheduledListModal.tsx')).toBe(false);
  });

  it('и не появились под другим путём: файлов с таким именем в chat/groups нет', () => {
    for (const dir of ['chat', 'groups']) {
      const names = fs.readdirSync(path.join(SRC, 'ui', 'components', 'modals', dir));
      expect(names.filter((n) => n.endsWith('ScheduledListModal.tsx'))).toEqual([]);
    }
  });

  it('общий файл на месте и экспортирует компонент, элемент и пропсы', () => {
    const s = SHARED();
    expect(s).toContain('export const ScheduledListModal = memo(ScheduledListModalImpl);');
    expect(s).toContain('export interface ScheduledItem {');
    expect(s).toContain('export interface ScheduledListModalProps {');
  });

  it('оба экрана берут его из общего места', () => {
    for (const src of [CHAT_SCREEN(), GROUPS_SCREEN()]) {
      expect(src).toContain(
        "import { ScheduledListModal } from '../components/modals/shared/ScheduledListModal';",
      );
      expect(src).toContain('<ScheduledListModal\n');
    }
  });

  it('прежние имена не остались ни в одном экране', () => {
    for (const src of [CHAT_SCREEN(), GROUPS_SCREEN()]) {
      expect(src).not.toContain('<ChatScheduledListModal');
      expect(src).not.toContain('<GroupScheduledListModal');
      expect(src).not.toContain('modals/chat/ChatScheduledListModal');
      expect(src).not.toContain('modals/groups/GroupScheduledListModal');
    }
  });

  it('второго типа элемента больше не объявляют', () => {
    const s = SHARED();
    expect(s).not.toContain('interface GroupScheduledItem');
    expect(CHAT_SCREEN()).not.toContain('GroupScheduledItem');
    expect(GROUPS_SCREEN()).not.toContain('GroupScheduledItem');
  });

  it('поведение v4.32.565 общий файл сохранил целиком', () => {
    const s = SHARED();
    // Причина задержки вместо пустой строки.
    expect(s).toContain('const verdict = decideScheduledSend(item);');
    expect(s).toContain('{held ? scheduledHoldTitle(held.code) : item.text}');
    expect(s).toContain('rowHeld: { fontStyle: \'italic\' },');
    // Поле состояния строки расписания и его тип.
    expect(s).toContain('readState?: ScheduledReadState;');
    // Строка обёрнута в memo — тема приходит пропсами, а не хуком внутри.
    // Проверяется именно тело строки: у самого списка `useTheme` законен.
    expect(s).toContain('const ScheduledRow = memo(ScheduledRowImpl);');
    const rowAt = s.indexOf('function ScheduledRowImpl(');
    expect(rowAt).toBeGreaterThan(-1);
    const rowBody = s.slice(rowAt, s.indexOf('\n}\n', rowAt));
    expect(rowBody).not.toContain('useTheme');
    expect(rowBody).toContain('mutedColor');
  });

  it('оба вызова передают один и тот же набор пропсов', () => {
    const propsAt = (src: string) => {
      const at = src.indexOf('<ScheduledListModal\n');
      expect(at).toBeGreaterThan(-1);
      return src
        .slice(at, src.indexOf('/>', at))
        .split('\n')
        .slice(1)
        .map((l) => l.trim().split('=')[0])
        .filter(Boolean);
    };
    expect(propsAt(CHAT_SCREEN())).toEqual(['visible', 'onClose', 'scheduled', 'onDelete']);
    expect(propsAt(GROUPS_SCREEN())).toEqual(['visible', 'onClose', 'scheduled', 'onDelete']);
  });
});
