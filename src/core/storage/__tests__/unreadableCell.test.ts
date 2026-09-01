/**
 * v4.32.556. Столбец, который не открылся, молчал — и успевал навредить.
 *
 * Показ пустотой был осознанным решением, и он верен. Но из этой же пустоты
 * пересобиралась производная подпись диалога и записывалась поверх прежней —
 * а прежняя была верной, её сложили, когда сообщение ещё читалось. Одна
 * неудачная расшифровка стирала последнюю осмысленную строку списка навсегда.
 *
 * И ни одно из примерно семидесяти мест, читающих зашифрованные столбцы, не
 * оставляло следа при неудаче: «ключ разошёлся с данными» и «данных правда
 * нет» выглядели в журнале одинаково.
 */
import fs from 'fs';
import path from 'path';
import { setFileSink } from '../../logger';
import {
  atRestDecryptFailures,
  decryptAtRestString,
  encryptAtRestString,
  resetAtRestDecryptFailures,
} from '../localEncryption';
import { mayWritePreview, previewAction, shouldReportFailure } from '../unreadableCell';

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const MODULE = (): string => read('../unreadableCell.ts');
const LOCAL = (): string => read('../local.ts');
const ENCRYPTION = (): string => read('../localEncryption.ts');

describe('производная подпись и непрочитанный источник', () => {
  it('источник прочитан — подпись пересобирается', () => {
    expect(previewAction(true, true)).toBe('write');
    expect(mayWritePreview('write')).toBe(true);
  });

  it('источник не открылся — прежняя подпись остаётся', () => {
    expect(previewAction(true, false)).toBe('keep');
    expect(mayWritePreview('keep')).toBe(false);
  });

  it('источника нет — подпись очищается, ей нечего описывать', () => {
    // Сильнее, чем «не читается»: иначе в списке осталась бы строка от
    // сообщения, которого больше не существует.
    expect(previewAction(false, false)).toBe('clear');
    expect(previewAction(false, true)).toBe('clear');
    expect(mayWritePreview('clear')).toBe(true);
  });
});

describe('как часто говорить о неудачной расшифровке', () => {
  it('первые три — всегда: по ним видно, что беда началась', () => {
    expect([1, 2, 3].map(shouldReportFailure)).toEqual([true, true, true]);
  });

  it('дальше только круглые числа — иначе один список даст сотню одинаковых строк', () => {
    expect(shouldReportFailure(4)).toBe(false);
    expect(shouldReportFailure(9)).toBe(false);
    expect(shouldReportFailure(10)).toBe(true);
    expect(shouldReportFailure(11)).toBe(false);
    expect(shouldReportFailure(99)).toBe(false);
    expect(shouldReportFailure(100)).toBe(true);
    expect(shouldReportFailure(1000)).toBe(true);
    expect(shouldReportFailure(1001)).toBe(false);
  });

  it('счёт начинается с единицы — нулевой и отрицательной неудачи не бывает', () => {
    expect(shouldReportFailure(0)).toBe(false);
    expect(shouldReportFailure(-1)).toBe(false);
    expect(shouldReportFailure(1.5)).toBe(false);
  });

  it('за пятьсот подряд неудач в журнал уходит семь строк, а не пятьсот', () => {
    let reported = 0;
    for (let i = 1; i <= 500; i++) if (shouldReportFailure(i)) reported++;
    expect(reported).toBe(5); // 1, 2, 3, 10, 100
  });
});

describe('неудача расшифровки перестала быть безмолвной', () => {
  const dek = new Uint8Array(32).fill(3);
  const other = new Uint8Array(32).fill(4);
  const lines: string[] = [];
  let warn: jest.SpyInstance;

  beforeEach(() => {
    lines.length = 0;
    resetAtRestDecryptFailures();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    setFileSink((l) => lines.push(l));
  });

  afterEach(() => {
    setFileSink(null);
    warn.mockRestore();
  });

  it('чужой ключ по-прежнему даёт пустую строку — показ не изменился', () => {
    expect(decryptAtRestString(encryptAtRestString('секрет', dek), other)).toBe('');
  });

  it('но теперь эта неудача сосчитана и названа', () => {
    const stored = encryptAtRestString('секрет', dek);
    decryptAtRestString(stored, other);
    expect(atRestDecryptFailures()).toBe(1);
    expect(lines.filter((l) => l.includes('at_rest_decrypt_failed'))).toHaveLength(1);
  });

  it('удачное чтение счётчик не трогает и в журнал не пишет', () => {
    const stored = encryptAtRestString('секрет', dek);
    expect(decryptAtRestString(stored, dek)).toBe('секрет');
    expect(atRestDecryptFailures()).toBe(0);
    expect(lines.filter((l) => l.includes('at_rest_decrypt_failed'))).toHaveLength(0);
  });

  it('длинное чтение не превращает журнал в одну строку, повторённую сто раз', () => {
    const stored = encryptAtRestString('секрет', dek);
    for (let i = 0; i < 100; i++) decryptAtRestString(stored, other);
    expect(atRestDecryptFailures()).toBe(100);
    // 1, 2, 3, 10, 100 — пять строк на сто неудач.
    expect(lines.filter((l) => l.includes('at_rest_decrypt_failed'))).toHaveLength(5);
  });

  it('пустой столбец и незашифрованный текст неудачей не считаются', () => {
    expect(decryptAtRestString('', dek)).toBe('');
    expect(decryptAtRestString('ещё не мигрированный текст', dek)).toBe('ещё не мигрированный текст');
    expect(atRestDecryptFailures()).toBe(0);
  });
});

describe('форма исходников', () => {
  it('правило живёт в модуле без зависимостей', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });

  it('обе уборки спрашивают правило, а не строят подпись из пустоты', () => {
    const src = LOCAL();
    expect(src.match(/previewAction\(true, cell\.state === 'plain'\)/g)).toHaveLength(2);
    expect(src).not.toContain(
      'const preview = previewLabelForText(decryptAtRestString(last.text, dek)).slice(0, LAST_MESSAGE_PREVIEW_MAX);'
    );
    // Непрочитанный источник оставляет след в журнале, а не тихую пустоту.
    expect(src).toContain("log.warn('conversation_preview_kept_unreadable'");
    expect(src).toContain("log.warn('group_preview_kept_unreadable'");
  });

  it('ветка «оставить прежнюю» вообще не упоминает last_message_preview', () => {
    const src = LOCAL();
    for (const marker of [
      "log.warn('conversation_preview_kept_unreadable'",
      "log.warn('group_preview_kept_unreadable'",
    ]) {
      const at = src.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      // Следующий за предупреждением UPDATE — до конца этого блока.
      const chunk = src.slice(at, at + 600);
      expect(chunk).toContain('UPDATE');
      expect(chunk.slice(0, chunk.indexOf('WHERE'))).not.toContain('last_message_preview');
    }
  });

  it('счётчик неудач считает именно провал, а не любой выход', () => {
    const src = ENCRYPTION();
    expect(src).toContain('atRestFailures += 1;');
    expect(src).toContain('if (shouldReportFailure(atRestFailures)) {');
    // Ранние возвраты (пустая строка, текст без префикса) стоят до счётчика.
    const at = src.indexOf('atRestFailures += 1;');
    const fnStart = src.indexOf('export function decryptAtRestString(');
    expect(src.slice(fnStart, at)).toContain("if (stored === '') return '';");
  });
});
