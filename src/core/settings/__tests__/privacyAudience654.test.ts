/**
 * Настройка приватности не расширяет аудиторию и не врёт об успехе (v4.32.654).
 *
 * Две правки одного круга, и обе — про молчаливый провал:
 *
 * 1. Видимость фотографии читалась `privacyPrefGetFor`, где сбой базы приходит
 *    тем же `null`, что и нетронутый переключатель, а `parseAvatarVisibility`
 *    отвечает на `null` самым разрешающим из трёх положений. Человек, выбравший
 *    `nobody`, отдавал фотографию всем, с кем шла переписка, если база не
 *    ответила в момент сборки конверта. Отозвать отправленное нельзя.
 *
 * 2. `notifyOnlineSet` возвращала `void`, хотя `kvSetChecked` под ней —
 *    `boolean`. Ветка `.catch` у экрана выглядела рабочей и не срабатывала ни
 *    разу, а тост «Уведомим, когда появится» стоял снаружи промиса и
 *    показывался даже тогда, когда на диске ничего не оставалось.
 */
import fs from 'fs';
import path from 'path';

const mockTryGetFor = jest.fn();
jest.mock('../privacyPrefs', () => ({
  // v4.32.694: запись отвечает, легла ли она.
  privacyPrefSet: jest.fn(async () => true),
  privacyPrefTryGetFor: (...a: unknown[]) => mockTryGetFor(...a),
}));

import { avatarVisibilityTryFor, parseAvatarVisibility } from '../avatarVisibility';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SYNC = () => read('core/social/profileSync.ts');
const PREFS = () => read('core/settings/privacyPrefs.ts');
const SCOPED = () => read('core/storage/profileScopedKv.ts');
const BLOCK = () => read('ui/components/modals/profile/ProfileChatBlock.tsx');
const CHAT = () => read('ui/screens/ChatScreen.tsx');

/** Строки кода без комментариев: свой же комментарий, цитирующий старую
 *  запись, иначе ломает отрицательные проверки. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

beforeEach(() => mockTryGetFor.mockReset());

describe('повод для правки жив', () => {
  it('разбор значения по-прежнему отвечает самым разрешающим положением', () => {
    // Если бы `parseAvatarVisibility` сам стал осторожным, отдельный
    // «пробующий» читатель был бы не нужен. Он не стал: экран настроек
    // показывает этим разбором положение переключателя, и там умолчание
    // «everybody» — правда о том, как вела себя прежняя версия.
    expect(parseAvatarVisibility(null)).toBe('everybody');
    expect(parseAvatarVisibility('чепуха')).toBe('everybody');
    expect(parseAvatarVisibility('nobody')).toBe('nobody');
  });

  it('обычное чтение настройки по-прежнему сводит сбой к «не записано»', () => {
    // Ровно то место, из-за которого понадобился privacyPrefTryGetFor.
    expect(SCOPED()).toContain('return (await scopedKvTryGetFor(pid, key))?.value ?? null;');
  });

  it('запись в базу по-прежнему отвечает булевым, который можно потерять', () => {
    expect(read('core/storage/local.ts')).toContain(
      'export async function kvSetChecked(key: string, value: string): Promise<boolean>',
    );
  });
});

describe('видимость фотографии: непрочитанное — не «всем»', () => {
  it('сбой чтения приходит как null, а не как разрешение', async () => {
    mockTryGetFor.mockResolvedValue(null);
    expect(await avatarVisibilityTryFor(7)).toBeNull();
  });

  it('нетронутый переключатель остаётся прежним умолчанием', async () => {
    mockTryGetFor.mockResolvedValue({ value: null });
    expect(await avatarVisibilityTryFor(1)).toBe('everybody');
  });

  it('выбранное положение доходит без изменений', async () => {
    mockTryGetFor.mockResolvedValue({ value: 'nobody' });
    expect(await avatarVisibilityTryFor(1)).toBe('nobody');
    mockTryGetFor.mockResolvedValue({ value: 'contacts' });
    expect(await avatarVisibilityTryFor(1)).toBe('contacts');
  });

  it('спрашивают именно про названный профиль', async () => {
    // Рассылка идёт на фоне и переживает переключение аккаунта: спросить
    // «активный» значило бы применить к чужому конверту чужое решение.
    mockTryGetFor.mockResolvedValue({ value: 'nobody' });
    await avatarVisibilityTryFor(3);
    expect(mockTryGetFor).toHaveBeenCalledWith(3, 'privacy_avatar_visibility');
  });
});

describe('рассылка карточки: непрочитанное не отдаёт фотографию', () => {
  it('правило отказа записано прямо в разрешающей функции', () => {
    const body = slice(SYNC(), 'function avatarAllowed(', '\nasync function buildEnvelope(');
    expect(body).toContain('visibility: AvatarVisibility | null');
    expect(body).toContain("if (visibility === null || visibility === 'nobody') return false;");
  });

  it('оба места рассылки берут пробующее чтение', () => {
    const src = codeOnly(SYNC());
    // Импорт и два вызова — ни одного прежнего читателя не осталось.
    expect(src.split('avatarVisibilityTryFor').length - 1).toBe(3);
    expect(src).toContain('avatarAllowed(await avatarVisibilityTryFor(pid), audience)');
    expect(src).not.toContain('avatarVisibilityFor(');
  });
});

describe('просьба «сообщить, когда появится»: отказ виден в типе', () => {
  it('запись отвечает булевым и жалуется в журнал', () => {
    // notifyOnlineSet — последняя функция файла, поэтому срез идёт до её
    // собственной закрывающей скобки в нулевой колонке.
    const body = slice(PREFS(), 'export async function notifyOnlineSet(', '\n}');
    expect(body).toContain('Promise<boolean>');
    expect(body).toContain("log.warn('notify_online_write_failed'");
    expect(body).toContain('return false;');
    // Общее имя снимается только после подтверждённой записи.
    expect(body).toContain('if (pid === 1) await kvDelete(key);\n  return true;');
  });

  it('экран профиля показывает обещание только после подтверждённой записи', () => {
    const body = slice(BLOCK(), 'const toggleNotifyOnline = useCallback(', 'const exportChat =');
    expect(body).toContain('ok = await m.notifyOnlineSet(peerB64, next);');
    expect(body).toContain('if (ok) {\n        if (next) showSuccess(');
    expect(body).toContain("setNotifyOnline(!next);\n      showError('Не удалось изменить уведомление');");
    // Прежней формы — тоста снаружи промиса — не осталось: обещание стоит
    // ровно одно и позже проверки записи, а не перед ней.
    const code = codeOnly(body);
    expect(code.split('showSuccess(').length - 1).toBe(1);
    expect(code.indexOf('showSuccess(')).toBeGreaterThan(code.indexOf('if (ok) {'));
  });

  it('снятие одноразовой просьбы, если не легло, видно в журнале', () => {
    const src = codeOnly(CHAT());
    expect(src).toContain('if (!(await notifyOnlineSet(peerB64, false))) {');
    expect(src).toContain("log.warn('ui_notify_online_clear_failed'");
  });
});

describe('проверка не пустая', () => {
  it('файлы прочитаны, а не пусты', () => {
    expect(SYNC().length).toBeGreaterThan(1000);
    expect(BLOCK().length).toBeGreaterThan(1000);
    expect(CHAT().length).toBeGreaterThan(1000);
  });

  it('якоря срезов встречаются ровно по разу', () => {
    expect(SYNC().split('function avatarAllowed(').length - 1).toBe(1);
    expect(PREFS().split('export async function notifyOnlineSet(').length - 1).toBe(1);
    expect(BLOCK().split('const toggleNotifyOnline = useCallback(').length - 1).toBe(1);
  });

  it('несуществующей строки в исходнике нет', () => {
    expect(codeOnly(SYNC())).not.toContain('avatarAllowedНикогда(');
  });
});
