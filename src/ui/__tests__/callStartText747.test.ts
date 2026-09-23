/**
 * Девять отказов, одна фраза (v4.32.747).
 *
 * Дефект. `initiateCall` отвечал `boolean`. Все пять мест, откуда в приложении
 * звонят — два значка в заголовке переписки, два пункта в меню списка бесед и
 * кнопка в карточке профиля, — писали на `false` одно и то же: «Не удалось
 * начать звонок». Отказывает же метод по девяти разным поводам, и человеку они
 * велят разное: сходить в настройки телефона за микрофоном, снять блокировку с
 * собеседника, проверить интернет, закончить текущий звонок, подождать
 * секунду после запуска. Ни одно из этих действий из фразы «Не удалось» не
 * следует, а половину из них подсказать больше некому — экрана, где видно, что
 * микрофону отказано, в приложении нет.
 *
 * Заодно убрана проверка `getCurrentCall()` перед звонком. Она стояла во всех
 * пяти местах и была строже, чем сама служба: `getCurrentCall()` отдаёт и
 * звонок в состоянии «Завершён», который живёт ещё 2,5 секунды после отбоя.
 * То есть перезвонить сразу после разговора было нельзя — приложение отвечало
 * «Уже активен звонок». Занятость линии теперь решает одно место, служба.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { callStartText } from '../callStartText';
import { NOT_READY_TEXT } from '../commonText';
import type { CallStartResult } from '../../core/social/callService';

/** Все исходы союза, перечисленные вручную: союз меняют — список замечает. */
const ALL: CallStartResult[] = [
  'started', 'busy', 'blocked', 'no-identity',
  'no-webrtc', 'no-signaling', 'no-permission', 'cancelled', 'failed',
];

/** Исходники, к которым привязаны проверки мест вызова. */
function source(relative: string): string {
  return readFileSync(join(__dirname, '..', relative), 'utf8');
}

const CALL_SITES = [
  'screens/ChatScreen.tsx',
  'screens/ChatListScreen.tsx',
  'components/UserProfilePeek.tsx',
];

describe('надпись отличает отказы друг от друга', () => {
  test('у каждого отказа своя фраза', () => {
    const said = ALL
      .map((r) => callStartText(r, false))
      .filter((t): t is string => t !== null);
    // Это и есть починенное: раньше здесь была бы одна фраза на всех.
    expect(new Set(said).size).toBe(said.length);
    expect(said.length).toBeGreaterThanOrEqual(6);
  });

  test('успех и собственный отбой молчат', () => {
    expect(callStartText('started', false)).toBeNull();
    expect(callStartText('started', true)).toBeNull();
    expect(callStartText('cancelled', false)).toBeNull();
    expect(callStartText('cancelled', true)).toBeNull();
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: у каждого исхода есть ответ, и он не пустая строка', () => {
    for (const r of ALL) {
      const text = callStartText(r, false);
      expect(text === null || text.length > 0).toBe(true);
    }
  });
});

describe('фразы говорят, что делать', () => {
  test('микрофон — про настройки телефона, и про камеру только в видеозвонке', () => {
    const audio = callStartText('no-permission', false) ?? '';
    const video = callStartText('no-permission', true) ?? '';
    expect(audio).toContain('микрофон');
    expect(audio).toContain('настройках телефона');
    expect(audio).not.toContain('камер');
    expect(video).toContain('камер');
  });

  test('блокировка — про блокировку, а не про неудачу', () => {
    expect(callStartText('blocked', false)).toContain('блокиров');
  });

  test('нет сети до сервера — про интернет', () => {
    expect(callStartText('no-signaling', false)).toContain('интернет');
  });

  test('линия занята — про то, что надо закончить текущий', () => {
    expect(callStartText('busy', false)).toContain('заверш');
  });

  test('приложение ещё запускается — общая надпись, а не своя', () => {
    // Состояние одно и то же во всём приложении; своя формулировка здесь
    // заставила бы человека думать, что поломки две. См. commonText.
    expect(callStartText('no-identity', false)).toBe(NOT_READY_TEXT);
  });

  test('видеозвонок называется видеозвонком', () => {
    expect(callStartText('failed', true)).toContain('видеозвонок');
    expect(callStartText('failed', false)).not.toContain('видео');
  });
});

describe('места вызова', () => {
  test('все пять зовут callStartText', () => {
    let total = 0;
    for (const file of CALL_SITES) {
      const src = source(file);
      expect(src).toContain("callStartText");
      total += (src.match(/initiateCall\(/g) ?? []).length;
    }
    expect(total).toBe(5);
  });

  test('прежней фразы на все случаи больше нет', () => {
    for (const file of CALL_SITES) {
      const src = source(file);
      expect(src).not.toContain("showError('Не удалось начать звонок')");
      expect(src).not.toContain("showError('Не удалось начать видеозвонок')");
      expect(src).not.toContain('showError(`Не удалось начать ${what}`)');
    }
  });

  test('занятость линии решает служба, а не экран', () => {
    for (const file of CALL_SITES) {
      expect(source(file)).not.toContain("showError('Уже активен звонок')");
    }
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: звонят по-прежнему из всех трёх файлов', () => {
    for (const file of CALL_SITES) {
      expect(source(file)).toContain('initiateCall(');
    }
  });
});

describe('союз не разошёлся со службой', () => {
  const SERVICE = readFileSync(join(__dirname, '../../core/social/callService.ts'), 'utf8');

  test('каждый исход и правда откуда-то возвращается', () => {
    for (const r of ALL) {
      // Исход, который назван в типе, но не возвращается ниоткуда, — это
      // надпись, которую никто никогда не увидит.
      expect(SERVICE).toContain(`return '${r}'`);
    }
  });

  test('из initiateCall больше не выходит голое false', () => {
    const from = SERVICE.indexOf('export async function initiateCall(');
    const to = SERVICE.indexOf('export async function acceptCall(', from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(SERVICE.slice(from, to)).not.toContain('return false');
  });
});
