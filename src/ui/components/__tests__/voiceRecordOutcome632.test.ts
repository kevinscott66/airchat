/**
 * Запись голосового не пропадает молча (v4.32.632).
 *
 * Оба конца жеста уходили в пустой catch. Не удалось открыть аудиотракт или
 * микрофон — человек зажимал кнопку, говорил и отпускал, а не происходило
 * ничего: ни записи, ни слова о причине. Не удалось закрыть рекордер —
 * осциллограмма и счётчик к тому моменту уже сброшены, и это выглядело как
 * исправно записанное и молча не отправленное голосовое. Повторить было
 * нечего, потому что о потере никто не говорил.
 *
 * Недописанный файл наружу не отдаётся — он может быть оборван на любом
 * месте, — но и в кэше открытым текстом не остаётся.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'VoiceMessage.tsx'), 'utf8');

/** Код без комментариев: пояснение не должно подменять проверку. */
const CODE = SRC.split('\n')
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

function slice(from: string, to: string): string {
  const a = CODE.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = CODE.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return CODE.slice(a, b);
}

describe('отказ записи доходит до человека', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: оба обработчика жеста на месте', () => {
    expect(CODE).toContain('const startRecording = useCallback(async () => {');
    expect(CODE).toContain('const stopRecording = useCallback(async () => {');
    expect(CODE).toContain("import { showError } from './userFeedback';");
  });

  it('не удалось начать — говорят об этом', () => {
    const body = slice('const startRecording = useCallback', 'const stopRecording = useCallback');
    expect(body).toContain("showError('Не удалось начать запись');");
  });

  it('не удалось закрыть рекордер — запись не выдают за отправленную', () => {
    const body = slice('const stopRecording = useCallback', '}, [stopPulse, onRecorded]);');
    expect(body).toContain("showError('Не удалось сохранить запись');");
    // Оборванный файл наружу не идёт и в кэше не остаётся.
    expect(body).toContain('if (rec.uri) await deleteCachedFileUris([rec.uri]);');
    expect(body).not.toMatch(/catch\s*\{\s*\}/);
  });

  it('целая запись по-прежнему уходит адресату', () => {
    const body = slice('const stopRecording = useCallback', '}, [stopPulse, onRecorded]);');
    const ok = body.indexOf('onRecorded({ uri, durationMs });');
    const fail = body.indexOf("showError('Не удалось сохранить запись');");
    expect(ok).toBeGreaterThan(-1);
    expect(fail).toBeGreaterThan(ok);
  });
});
