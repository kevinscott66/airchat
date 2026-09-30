/**
 * «Поделиться» перестало выдавать оборванную связь за слишком большой файл
 * (v4.32.1076).
 *
 * Дефект. `downloadCapped` отвечал `string | null`. `null` приходил из двух
 * мест: с потолка (`overLimit`) и с `downloadAsync().catch(() => null)` — то
 * есть при любом броске закачки: нет сети, оборванный TLS, отменённая задача.
 * Единственный вызывающий различить их не мог и на любой `null` показывал
 * «Файл слишком большой, чтобы им поделиться». Третьего случая не было в коде
 * вовсе: ответ 404, 403 или 500 приходит УСПЕШНО, `downloadAsync` отдаёт
 * результат со `status`, а на диск ложится тело ошибки — и просмотрщик отдавал
 * его в «Поделиться» с типом image/jpeg.
 *
 * Цена. Человеку про его собственный интернет говорили «файл большой»:
 * повторять незачем, ждать нечего, приговор окончательный — и ложный. Про
 * удалённое вложение то же самое. А страница ошибки под видом фотографии
 * уходила дальше — в другое приложение, в чужую переписку, в облако.
 *
 * Правка. Исход вместо «строка или ничего»: три причины, три текста. Ответ
 * сервера от 400 и выше — отказ, скачанное стирается.
 *
 * Границы. Нижняя граница статуса нарочно не проверяется: платформа, однажды
 * отдавшая `0` вместо статуса, не должна превратить хороший файл в отказ.
 */
import fs from 'fs';
import path from 'path';

import {
  MAX_SHARE_BYTES,
  shareDownloadFailText,
  shareStatusRefused,
} from '../shareDownload';

const SRC = path.join(__dirname, '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const MV = codeOnly(read('components', 'MediaViewer.tsx'));

describe('три причины названы тремя разными словами', () => {
  it('потолок назван числом, и это то же число, что и в проверке', () => {
    const text = shareDownloadFailText('too_big');
    expect(text).toContain('52,4 МБ');
    // Подпись округлена вниз: пропустит проверка ровно столько.
    expect(MAX_SHARE_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_SHARE_BYTES / 1_000_000).toBeGreaterThan(52.4);
  });

  it('обрыв связи не выдаётся за размер', () => {
    const text = shareDownloadFailText('network');
    expect(text).toContain('связь');
    expect(text).not.toContain('большой');
    expect(text).not.toContain('МБ');
    // И зовёт повторить: в отличие от потолка, повтор здесь имеет смысл.
    expect(text).toContain('попробуйте ещё раз');
  });

  it('отказ сервера не выдаётся ни за размер, ни за обрыв', () => {
    const text = shareDownloadFailText('server');
    expect(text).toContain('Сервер не отдал файл');
    expect(text).not.toContain('большой');
    expect(text).not.toContain('МБ');
    expect(text).not.toContain('интернет');
  });

  it('ГРАНИЦА: все три текста разные', () => {
    const all = [
      shareDownloadFailText('too_big'),
      shareDownloadFailText('network'),
      shareDownloadFailText('server'),
    ];
    expect(new Set(all).size).toBe(3);
  });

  it('отказом считается только явное 400 и выше', () => {
    expect(shareStatusRefused(400)).toBe(true);
    expect(shareStatusRefused(403)).toBe(true);
    expect(shareStatusRefused(404)).toBe(true);
    expect(shareStatusRefused(500)).toBe(true);
    expect(shareStatusRefused(200)).toBe(false);
    expect(shareStatusRefused(206)).toBe(false);
    expect(shareStatusRefused(304)).toBe(false);
    expect(shareStatusRefused(399)).toBe(false);
  });

  it('ГРАНИЦА: молчащий статус читается как «файл настоящий»', () => {
    // Ошибиться лучше в сторону прежнего поведения, чем отказать по файлу,
    // с которым всё в порядке.
    expect(shareStatusRefused(0)).toBe(false);
    expect(shareStatusRefused(undefined)).toBe(false);
    expect(shareStatusRefused(null)).toBe(false);
    expect(shareStatusRefused(Number.NaN)).toBe(false);
  });
});

describe('форма правки в просмотрщике', () => {
  it('закачка отвечает исходом, а не «строка или ничего»', () => {
    expect(MV).toContain(
      'async function downloadCapped(url: string, dest: string): Promise<ShareDownloadOutcome> {'
    );
    expect(MV).not.toContain('Promise<string | null>');
  });

  it('три исхода различены по отдельности и в этом порядке', () => {
    expect(MV).toContain("if (overLimit) return await fail('too_big');");
    expect(MV).toContain("if (!res) return await fail('network');");
    expect(MV).toContain("if (shareStatusRefused(res.status)) return await fail('server');");
    expect(MV).toContain('return { ok: true, uri: res.uri };');
    // Потолок раньше обрыва: отменённая задача отдаёт `undefined`, и без
    // этого порядка «не влез» превратилось бы в «нет сети».
    expect(MV.indexOf("fail('too_big')")).toBeLessThan(MV.indexOf("fail('network')"));
    // Уборка за собой одна на все три исхода, а не переписана трижды.
    expect([...MV.matchAll(/await fail\(/g)]).toHaveLength(3);
  });

  it('прежний текст про размер больше не показывается на всё подряд', () => {
    expect(MV).not.toContain('Файл слишком большой, чтобы им поделиться');
    expect(MV).toContain(
      "if (!got.ok) { Alert.alert('AirChat', shareDownloadFailText(got.why)); return; }"
    );
    expect(MV).toContain('localUri = got.uri;');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: потолок и уборка за собой на месте', () => {
    // Сам сторож размера не тронут: он и есть смысл этой функции с v4.32.355.
    expect(MV).toContain(
      'if (p.totalBytesWritten > MAX_SHARE_BYTES || p.totalBytesExpectedToWrite > MAX_SHARE_BYTES) {'
    );
    expect(MV).toContain('cancel = () => { void task.cancelAsync().catch(() => {}); };');
    // Недокачанное стирается по-прежнему — теперь на всех трёх исходах сразу.
    expect(MV).toContain(
      'await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});'
    );
  });

  it('ГРАНИЦА: проверка адреса до закачки не тронута', () => {
    expect(MV).toContain('const verdict = classifyShareUrl(uri);');
    expect(MV).toContain(
      "if (verdict !== 'ok') { Alert.alert('AirChat', SHARE_URL_REFUSAL[verdict]); return; }"
    );
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('бросок закачки по-прежнему приходит как «ничего»', () => {
    // Строка, с которой всё началось: информация о причине теряется прямо
    // здесь. Правка не вернула её — она развела последствия.
    expect(MV).toContain('const res = await task.downloadAsync().catch(() => null);');
  });

  it('скачивают только по http(s), так что статус — настоящий ответ сервера', () => {
    expect(MV).toContain('if (/^https?:\\/\\//i.test(uri)) {');
  });

  it('у закачки ровно один вызывающий — тексту больше неоткуда разойтись', () => {
    expect([...MV.matchAll(/downloadCapped\(/g)]).toHaveLength(2);
  });
});
