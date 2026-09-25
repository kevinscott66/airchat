/**
 * Срок исчезающих сообщений в группе — словами (v4.32.925).
 *
 * Дефект: полоса над перепиской группы считала срок сама — «5 мин», «2 ч»,
 * «7 д», — тогда как та же полоса в личном чате зовёт `formatDisappearLabel`,
 * а окно настройки той же группы (`GroupsScreen` :885) зовёт её же. Три
 * подписи об одном и том же сроке, две согласованные и одна нет.
 *
 * Цена: срок в 90 минут полоса показывала как «1.5 ч» — с ЛАТИНСКОЙ точкой в
 * русской строке, — а сутки как «1 д», где обрубок читается и как «день», и
 * как «два дня» из соседней строки. Полоса эта — единственное на экране
 * напоминание, что написанное здесь через столько-то исчезнет; человек по ней
 * решает, писать ли вообще.
 *
 * Правка: тот же `formatDisappearLabel`, что и в личном чате. Ширина здесь
 * ничего не стоит: полоса своя, во всю ширину экрана, и ни с чем её не делит —
 * в отличие от строки списка групп, где сокращение оставлено намеренно
 * (см. countedNounPlural899).
 *
 * Границы: проверка идёт по исходнику. Полоса сидит внутри экрана на четыре
 * с лишним тысячи строк, поднять который в тесте — значит поднять половину
 * приложения; тот же приём и по той же причине применён в peekWritesChecked.
 */
import fs from 'fs';
import path from 'path';

import { formatDisappearLabel } from '../../core/social/disappearEnvelope';

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');
/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

const GROUPS = codeOnly('screens/GroupsScreen.tsx');
const CHAT = codeOnly('screens/ChatScreen.tsx');

describe('полоса срока в группе считает так же, как везде', () => {
  it('самодельного счёта в полосе не осталось', () => {
    for (const cut of ['/ 86400000} д`', '/ 3600000} ч`', '/ 60000} мин`']) {
      expect(GROUPS).not.toContain(cut);
    }
  });

  it('полоса зовёт общую подпись', () => {
    const at = GROUPS.indexOf("{'Исчезают через '}");
    expect(at).toBeGreaterThan(0);
    expect(GROUPS.slice(at, at + 200)).toContain('formatDisappearLabel(disappearMs)');
  });

  it('в группе и в личном чате подпись теперь одна и та же', () => {
    expect(CHAT).toContain('formatDisappearLabel(disappearMs)');
    expect(GROUPS).toContain('formatDisappearLabel(disappearMs)');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: подпись и правда склоняет и не рвёт слова', () => {
  it('сутки и часы — словами, а не буквой', () => {
    expect(formatDisappearLabel(86_400_000)).toBe('1 день');
    expect(formatDisappearLabel(2 * 86_400_000)).toBe('2 дня');
    expect(formatDisappearLabel(7 * 86_400_000)).toBe('7 дней');
    expect(formatDisappearLabel(3_600_000)).toBe('1 час');
    expect(formatDisappearLabel(5 * 3_600_000)).toBe('5 часов');
  });

  it('дробного часа с латинской точкой не выходит вовсе', () => {
    expect(formatDisappearLabel(90 * 60_000)).toBe('90 минут');
    expect(formatDisappearLabel(90 * 60_000)).not.toContain('.');
  });

  it('окно настройки той же группы звало общую подпись и раньше', () => {
    // Иначе «в группе подпись одна» было бы правдой и в экране, где её зовут
    // ровно в одном месте из трёх.
    expect(GROUPS).toContain('formatDisappearLabel(ms)');
    expect(GROUPS).toContain("import { formatDisappearLabel } from '../../core/social/disappearEnvelope';");
  });
});
