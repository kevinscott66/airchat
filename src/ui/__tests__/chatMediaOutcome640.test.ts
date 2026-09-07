/**
 * Сбой чтения вложений переписки — не «вложений нет» (v4.32.640).
 *
 * `listConversationMedia` ловила любое исключение и возвращала пустой список.
 * Окно общих медиа принимало это за факт: вкладка «Медиа» писала «Нет
 * медиафайлов», вкладки «Ссылки» и «Файлы» — «Нет ссылок» и «Нет файлов», а
 * карточка собеседника показывала «0 медиа». То есть переписка с сотней
 * фотографий выглядела перепиской без единого вложения — из-за секундной
 * блокировки базы, и отличить это от настоящей пустоты было нечем.
 *
 * В группах тот же случай закрыт с v4.32.532 (listGroupConversationMedia,
 * GroupSharedMediaModal). Здесь — тем же способом: третий исход чтения из
 * `core/storage/readResult` и общий текст об отказе на все вкладки.
 */
import fs from 'fs';
import path from 'path';

const UI = path.join(__dirname, '..');
const readUi = (...p: string[]): string => fs.readFileSync(path.join(UI, ...p), 'utf8');
const stripComments = (s: string): string => s.replace(/^\s*\/\/.*$/gm, '');

const LOCAL = fs.readFileSync(path.join(UI, '..', 'core', 'storage', 'local.ts'), 'utf8');
const MODAL = stripComments(readUi('components', 'modals', 'chat', 'ChatSharedMediaModal.tsx'));
const BLOCK = stripComments(readUi('components', 'modals', 'profile', 'ProfileChatBlock.tsx'));
const GROUP = readUi('components', 'modals', 'groups', 'GroupSharedMediaModal.tsx');

/** Тело одной экспортируемой функции из очень большого файла. */
function fnBody(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('вложения переписки: сбой чтения отличается от пустоты (v4.32.640)', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: файлы прочитаны и это те самые файлы', () => {
    expect(MODAL.length).toBeGreaterThan(2000);
    expect(BLOCK.length).toBeGreaterThan(2000);
    expect(MODAL).toContain('listConversationMedia');
    expect(BLOCK).toContain('listConversationMedia');
    expect(LOCAL).toContain('export async function listConversationMedia(');
  });

  it('выборка отдаёт null вместо пустого списка', () => {
    const body = fnBody(
      LOCAL,
      'export async function listConversationMedia(',
      'export async function listGroupConversationMedia('
    );
    expect(body).toContain('Promise<DbRead<SharedMediaRow>>');
    expect(body).toContain('list_conversation_media_failed');
    expect(body).toContain('return null;');
    // Пустой список — это ответ «вложений нет», и на сбое его быть не должно.
    expect(body).not.toContain('return [];');
  });

  it('окно различает три исхода и не пишет пустоту в состояние', () => {
    expect(MODAL).toContain('const [readFailed, setReadFailed] = useState(false);');
    expect(MODAL).toContain('if (!shouldApplyRows(rows)) { setReadFailed(true); return; }');
    expect(MODAL).toContain('if (!shouldApplyRows(msgs)) { setReadFailed(true); return; }');
    // Второе чтение окна раньше глотало отказ пустым catch.
    expect(MODAL).not.toContain('.catch(() => {})');
    expect(MODAL).toContain('.catch(() => { if (!cancelled) setReadFailed(true); });');
  });

  it('повторное открытие не остаётся с прежним отказом', () => {
    // Без сброса вкладка навсегда застревала бы на тексте об ошибке.
    expect(MODAL).toContain('setReadFailed(false);');
  });

  it('все пустые вкладки говорят об отказе одним текстом', () => {
    expect(MODAL).toContain("const CSM_READ_FAILED = 'Не удалось прочитать переписку';");
    expect(MODAL).toContain('{readFailed ? CSM_READ_FAILED : text}');
    expect(MODAL).toContain("name={readFailed ? 'alert-circle-outline' : icon}");
    // Текст один на все вкладки — как в группах.
    expect(GROUP).toContain("const GSM_READ_FAILED = 'Не удалось прочитать переписку';");
    // Ни одна вкладка не рисует свой собственный «нет ...» мимо empty().
    for (const t of ['Нет медиафайлов', 'Нет ссылок', 'Нет файлов', 'Нет музыки', 'Нет голосовых']) {
      expect(MODAL).toContain(`'${t}'`);
    }
    expect(MODAL.match(/paneStyles\.emptyText/g)).toHaveLength(1);
  });

  it('счётчик в карточке собеседника не выдаёт неизвестность за ноль', () => {
    expect(BLOCK).toContain('const [mediaCount, setMediaCount] = useState<number | null>(0);');
    expect(BLOCK).toContain('shouldApplyRows(m) ? readableMediaCount(m) : null');
    expect(BLOCK).toContain('.catch(() => { if (!cancelled) setMediaCount(null); });');
    expect(BLOCK).toContain("{mediaCount ?? '—'}");
  });

  it('повод для правки жив: групповая выборка по-прежнему трёхисходная', () => {
    expect(LOCAL).toContain('export async function listGroupConversationMedia(');
    const body = fnBody(
      LOCAL,
      'export async function listGroupConversationMedia(',
      '// ─── Scheduled Messages'
    );
    expect(body).toContain('Promise<DbRead<SharedMediaRow>>');
  });
});
