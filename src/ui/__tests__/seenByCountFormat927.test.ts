/**
 * Счётчик прочтений под сообщением: одно число — один вид (v4.32.927).
 *
 * Дефект. Под сообщением в группе стоят ДВА счётчика одной и той же
 * величины — длины списка прочитавших. Автору показывалась двойная
 * галочка с числом целиком, подписчику канала — глаз с сокращённым:
 * `` `${(len / 1000).toFixed(1)}K` ``. Одна и та же запись читалась как «1247»
 * у одного человека и как «1.2K» у другого.
 *
 * Цена. В сокращении две чужие буквы сразу: латинская K и латинская точка
 * в дроби — в русском интерфейсе, где дробная часть отделяется запятой.
 *
 * Правка. Сокращение убрано, а не переведено. Русское «1,2 тыс.» — восемь
 * знаков против четырёх у точного «1247»: сокращение, которое длиннее
 * исходного и при этом теряет точность, не нужно нигде. Английское «1.2K»
 * короче своего «1247» — потому оно там и живёт, и потому же приехало сюда.
 *
 * Границы. Проверка идёт по исходнику: оба счётчика сидят внутри рисовалки
 * строки экрана на шесть с лишним тысяч строк. Тот же приём и по той же
 * причине применён в disappearBannerPlural925.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** Только код: комментарий не должен сам удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

const GROUPS = codeOnly(
  readFileSync(join(__dirname, '..', 'screens', 'GroupsScreen.tsx'), 'utf8'),
);

/**
 * Подвал строки сообщения: от галочки автора до часа под сообщением.
 * Именно здесь стоят оба счётчика прочтений, и только их тут и спрашивают.
 */
function footer(): string {
  const at = GROUPS.indexOf('<Ionicons name="checkmark-done" size={13}');
  expect(at).toBeGreaterThan(0);
  const to = GROUPS.indexOf("Alert.alert('', fullDateTime(item.createdAt))", at);
  expect(to).toBeGreaterThan(at);
  return GROUPS.slice(at, to);
}

describe('оба счётчика прочтений пишут одно и то же (v4.32.927)', () => {
  it('латинской K в подвале больше нет', () => {
    expect(footer()).not.toContain('K`');
  });

  it('дроби с латинской точкой выйти больше неоткуда', () => {
    expect(footer()).not.toContain('toFixed(');
  });

  it('порога в тысячу больше нет: число не меняет вид на ходу', () => {
    expect(footer()).not.toContain('1000');
  });

  it('оба счётчика рисуют ровно длину списка прочитавших', () => {
    expect(footer().match(/\{item\.seenBy!\.length\}/g)).toHaveLength(2);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: подвал сообщения на месте', () => {
  it('в подвале и правда два разных значка прочтений', () => {
    const f = footer();
    expect(f).toContain('name="checkmark-done"');
    expect(f).toContain('name="eye-outline"');
  });

  it('оба стоят на одной и той же величине', () => {
    expect(footer().match(/item\.seenBy\?\.length \?\? 0/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it('счётчик автора открывает список прочитавших, и это не тронуто', () => {
    // Нажатие объявлено выше значка, то есть до начала вырезки.
    expect(GROUPS).toContain('setSeenByMsg(item)');
  });

  it('знак вопроса для нерасшифрованного списка остался выше', () => {
    expect(GROUPS).toContain('name="eye-off-outline"');
  });
});
