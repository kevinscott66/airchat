import { checkSeedWordCount, normalizeSeedInput } from '../seedInput';

const TWELVE = 'a b c d e f g h i j k l';
const TWENTY_FOUR = `${TWELVE} ${TWELVE}`;

describe('normalizeSeedInput', () => {
  it('обычный ввод остаётся собой', () => {
    expect(normalizeSeedInput('abandon ability able')).toBe('abandon ability able');
  });

  it('лишние пробелы, отступы и переводы строк схлопываются', () => {
    expect(normalizeSeedInput('  abandon\n\nability\t able  ')).toBe('abandon ability able');
  });

  it('регистр приводится к строчному', () => {
    expect(normalizeSeedInput('Abandon ABILITY AbLe')).toBe('abandon ability able');
  });

  it('нумерация со своего же экрана сидки не мешает', () => {
    // Экран показывает «1. abandon» — ровно это и попадает в буфер обмена.
    expect(normalizeSeedInput('1. abandon 2. ability 3. able')).toBe('abandon ability able');
  });

  it('номер, приклеенный к слову, тоже снимается', () => {
    expect(normalizeSeedInput('1.abandon 2)ability 3. able')).toBe('abandon ability able');
  });

  it('запятые и точки с запятой считаются разделителями', () => {
    expect(normalizeSeedInput('abandon, ability; able')).toBe('abandon ability able');
  });

  it('неразрывный пробел из заметок не склеивает слова', () => {
    expect(normalizeSeedInput('abandon ability able')).toBe('abandon ability able');
  });

  it('пустой и пробельный ввод дают пустую строку', () => {
    expect(normalizeSeedInput('')).toBe('');
    expect(normalizeSeedInput('   \n\t ')).toBe('');
    expect(normalizeSeedInput('1. 2. 3.')).toBe('');
  });

  it('не превращает неверное слово в верное', () => {
    // Разбор трогает только оформление: буквы остаются как есть.
    expect(normalizeSeedInput('abandonn abilty')).toBe('abandonn abilty');
  });
});

describe('checkSeedWordCount', () => {
  it('24 слова — норма', () => {
    expect(checkSeedWordCount(TWENTY_FOUR)).toEqual({ ok: true });
  });

  it('12 слов принимаем ради фразы из другого приложения', () => {
    expect(checkSeedWordCount(TWELVE)).toEqual({ ok: true });
  });

  it('пустой ввод — своя подсказка, а не «неверное количество: 1»', () => {
    const res = checkSeedWordCount('');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('24 слова через пробел');
  });

  it('потерянное слово названо числом', () => {
    const res = checkSeedWordCount(TWENTY_FOUR.split(' ').slice(0, 23).join(' '));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('23');
  });

  it('лишнее слово тоже отлавливается', () => {
    const res = checkSeedWordCount(`${TWENTY_FOUR} extra`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('25');
  });

  it('одно слово — не пустой ввод, а неверное количество', () => {
    const res = checkSeedWordCount('abandon');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('1');
  });
});
