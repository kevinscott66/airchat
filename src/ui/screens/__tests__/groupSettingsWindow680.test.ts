/**
 * v4.32.680: одно окно настроек группы вместо двух списков пунктов.
 *
 * В GroupsScreen стояли два вызова `openSheet`: «Настройки группы» с
 * семнадцатью строками у администратора и «Параметры чата» с восемью у
 * участника. Общие пункты — уведомления с подменю отсрочки, автоперевод, фон,
 * кегль, медиа, избранное — были в обеих ветках дословной копией. Тест держит
 * форму: копии больше нет, окно одно, а его состав считает groupHubModel.
 *
 * Поведение самой модели проверяется отдельно и без React —
 * `components/__tests__/groupHubModel680.test.ts`.
 */
import fs from 'fs';
import path from 'path';

const SCREEN = fs.readFileSync(path.join(__dirname, '../GroupsScreen.tsx'), 'utf8');
const MODAL = fs.readFileSync(
  path.join(__dirname, '../../components/modals/groups/GroupSettingsModal.tsx'),
  'utf8'
);

/** Строки без комментариев: объяснение правки не считается правкой. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*'));
    })
    .join('\n');
}

const CODE = codeOnly(SCREEN);

describe('окно настроек группы подключено к экрану', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: экран прочитан целиком', () => {
    expect(SCREEN.length).toBeGreaterThan(100_000);
    expect(MODAL.length).toBeGreaterThan(2_000);
  });

  it('прежних двух списков пунктов больше нет', () => {
    expect(CODE).not.toContain("openSheet('Настройки группы'");
    expect(CODE).not.toContain("openSheet('Параметры чата'");
    expect(CODE).not.toContain("group.type === 'channel' ? 'Настройки канала' : 'Настройки группы'");
  });

  it('окно одно, и его открывает одна кнопка', () => {
    expect(CODE).toContain('<GroupSettingsModal');
    expect(CODE).toContain('facts={settingsFacts}');
    expect(CODE).toContain('onSelect={handleGroupSetting}');
    expect((CODE.match(/setSettingsOpen\(true\)/g) ?? [])).toHaveLength(1);
    expect(CODE).toContain("accessibilityLabel=\"Настройки\"");
  });

  it('состав окна считает модель, а не экран', () => {
    expect(SCREEN).toContain("from '../components/groupHubModel'");
    expect(SCREEN).toContain('const settingsFacts: GroupHubFacts = {');
    // «Супергруппа» на этом экране всюду ведёт себя как группа.
    expect(CODE).toContain("type: group.type === 'channel' ? 'channel' : 'group',");
  });

  it('каждый id модели разобран обработчиком', () => {
    const ids = [
      'mute', 'auto_translate', 'wallpaper', 'font_size',
      'media', 'starred', 'recently_deleted',
      'slow_mode', 'disappear', 'invite_link', 'stats',
      'admin_only_posting', 'admin_only_pinning', 'require_approval', 'anonymous_posting',
      'export', 'clear_history',
    ];
    const at = CODE.indexOf('const handleGroupSetting = (');
    expect(at).toBeGreaterThan(0);
    const body = CODE.slice(at, CODE.indexOf('\n  return (', at));
    expect(body.length).toBeGreaterThan(3_000);
    for (const id of ids) expect(body).toContain(`case '${id}':`);
  });

  it('переключатель берёт положение из окна, а не пересчитывает своё', () => {
    // Окно не закрывается на переключателе и уже нарисовало новое положение:
    // считать его от старого значения — значит разойтись с картинкой.
    expect(CODE).toContain('const newVal = next ?? !autoTranslate;');
    expect(CODE).not.toContain('const newVal = !autoTranslate;');
  });

  it('необратимое по-прежнему спрашивает и по-прежнему под перехватом', () => {
    const at = CODE.indexOf("case 'clear_history':");
    expect(at).toBeGreaterThan(0);
    const body = CODE.slice(at, at + 1_400);
    expect(body).toContain('Alert.alert(');
    expect(body).toContain('await clearGroupMessages(');
    expect(body).toContain('userErrorText(e,');
  });

  it('окно не вписывает кегль и скругление числом', () => {
    expect(codeOnly(MODAL)).not.toMatch(/fontSize: *[0-9]/);
    expect(codeOnly(MODAL)).not.toMatch(/borderRadius: *[0-9]/);
    expect(MODAL).toContain('minHeight: TOUCH_TARGET_MIN');
  });

  it('таблица значков покрыта типом, а не подобрана на глаз', () => {
    expect(MODAL).toContain('const ICON: Record<GroupSettingId,');
  });
});
