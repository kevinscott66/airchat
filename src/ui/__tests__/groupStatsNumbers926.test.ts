/**
 * Статистика группы: числа и даты по общим правилам (v4.32.926).
 *
 * Дефект первый. Подпись под столбиком графика собиралась тут же, в окне:
 * `d.date.slice(5).replace('-', '/')`. Из `2026-09-25` выходило «09/25» — месяц
 * впереди дня, как пишут по-американски, в русском окне, где соседняя строка
 * говорит «25 сентября 2026». Седьмой столбик — сегодняшний, и человек,
 * сверяя его с числом, первым делом решает, что график показывает не те дни.
 *
 * Дефект второй. Подпись плитки была жёсткой строкой при любом числе: в группе
 * из двоих плитка читается «2 Участников», в новой — «1 Сообщений». Правило
 * окончаний лежало в том же файле ввезённым и звалось строкой ниже — в списке
 * самых активных; до плиток оно просто не дошло.
 *
 * Цена. Оба места — одно окно, которое открывают раз в жизни, так что денег
 * это не стоит. Но стоит доверия: окно «Статистика» затем и открывают, чтобы
 * сверить числа, и половина его строк выглядела написанной не для этого языка.
 *
 * Правка. Дата ушла в `dayMonthShortFromYmd` рядом с остальными русскими датами,
 * подписи плиток — в `pluralRu`, который в этом же файле уже работал.
 *
 * Границы. То, что день разбирается МЕСТНЫМ счётом, закреплено по исходнику,
 * а не поведением, и это проверено: `process.env.TZ` в самом начале файла на
 * часовой пояс уже не влияет — рабочий процесс jest берёт его раньше и больше не
 * перечитывает. А разница между `new Date('2026-09-25')` и `new Date(2026, 8, 25)` видна
 * только западнее Гринвича; здесь пояс московский, и любая проверка по исходу
 * была бы зелёной и на гринвичском разборе — то есть не стоила бы ничего.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ruDateTime from '../../core/time/ruDateTime';
import { dayMonthShort } from '../../core/time/ruDateTime';
import { pluralRu } from '../../core/storage/ruPlural';

/**
 * Запасной путь здесь не для удобства. На коде до правки такого экспорта нет
 * вовсе, и прямой ввоз уронил бы весь набор на загрузке — красными стали бы
 * и контрольные проверки, и доказательство «без правки падало именно поведение»
 * потеряло бы смысл. Спрятать пропажу он не может: ниже стоит проверка, что
 * экспорт есть на самом деле.
 */
const fromYmd = (ruDateTime as Partial<typeof ruDateTime>).dayMonthShortFromYmd;

/** Позвать подпись, назвав отсутствие экспорта своими словами. */
function label(ymd: string): string {
  if (!fromYmd) throw new Error('ruDateTime не отдаёт подпись дня из строки');
  return fromYmd(ymd);
}

/** Только код: комментарий не должен сам удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

const MODAL = codeOnly(
  readFileSync(join(__dirname, '..', 'components', 'modals', 'groups', 'GroupStatsModal.tsx'), 'utf8'),
);
const RU_DATE = codeOnly(
  readFileSync(join(__dirname, '..', '..', 'core', 'time', 'ruDateTime.ts'), 'utf8'),
);

describe('график: день подписан по-русски, а не дробью (v4.32.926)', () => {
  it('из 2026-09-25 выходит «25 сен»', () => {
    expect(label('2026-09-25')).toBe('25 сен');
  });

  it('ноль впереди числа срезан, как во всех остальных датах приложения', () => {
    expect(label('2026-01-01')).toBe('1 янв');
    expect(label('2026-12-09')).toBe('9 дек');
  });

  it('подпись та же самая, что у остальных коротких дат', () => {
    expect(label('2026-09-25')).toBe(dayMonthShort(new Date(2026, 8, 25).getTime()));
  });

  it('строка не той формы даёт пусто, а не «NaN undefined»', () => {
    expect(label('25.09.2026')).toBe('');
    expect(label('2026-13-01')).toBe('');
    expect(label('')).toBe('');
  });

  it('самодельной сборки подписи в окне не осталось', () => {
    expect(MODAL).not.toContain("slice(5)");
    expect(MODAL).toContain('const dayLabel = dayMonthShortFromYmd(d.date);');
  });

  it('день разбирается местным счётом, а не гринвичским', () => {
    const at = RU_DATE.indexOf('export function dayMonthShortFromYmd(');
    expect(at).toBeGreaterThan(0);
    const body = RU_DATE.slice(at, RU_DATE.indexOf('export function', at + 10));
    expect(body).toContain('new Date(Number(m[1]), month - 1, day)');
    // Строка целиком в конструктор — это полночь UTC по стандарту.
    expect(body).not.toContain('new Date(ymd)');
    expect(body).not.toContain('Date.parse(');
  });
});

describe('плитки: подпись согласована с числом над ней (v4.32.926)', () => {
  it('жёстких подписей больше нет', () => {
    expect(MODAL).not.toContain("{ label: 'Сообщений'");
    expect(MODAL).not.toContain("{ label: 'Медиафайлов'");
    expect(MODAL).not.toContain("{ label: 'Участников'");
  });

  it('все три плитки спрашивают окончание у общего правила', () => {
    expect(MODAL).toContain("pluralRu(grpStats.totalMessages, 'Сообщение', 'Сообщения', 'Сообщений')");
    expect(MODAL).toContain("pluralRu(grpStats.mediaCount, 'Медиафайл', 'Медиафайла', 'Медиафайлов')");
    expect(MODAL).toContain("pluralRu(memberCount, 'Участник', 'Участника', 'Участников')");
  });

  it('группа из двоих и первое сообщение читаются по-русски', () => {
    expect(pluralRu(2, 'Участник', 'Участника', 'Участников')).toBe('Участника');
    expect(pluralRu(1, 'Сообщение', 'Сообщения', 'Сообщений')).toBe('Сообщение');
  });

  it('ключ строки больше не привязан к подписи: она теперь плывёт', () => {
    expect(MODAL).not.toContain('key={item.label}');
    expect(MODAL).toContain('key={item.icon}');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: окно и правило на месте', () => {
  it('окно и правда рисует и плитки, и столбики', () => {
    expect(MODAL).toContain('styles.tilesRow');
    expect(MODAL).toContain('styles.chartRow');
    expect(MODAL).toContain('Активность за 7 дней');
  });

  it('общее правило окончаний работало и до этой правки', () => {
    expect(pluralRu(5, 'Участник', 'Участника', 'Участников')).toBe('Участников');
    expect(pluralRu(11, 'Участник', 'Участника', 'Участников')).toBe('Участников');
    expect(pluralRu(21, 'Участник', 'Участника', 'Участников')).toBe('Участник');
  });

  it('дату первого сообщения окно звало у общего правила и раньше', () => {
    expect(MODAL).toContain('dayMonthLongYear(grpStats.firstMessageAt)');
  });

  it('короткий месяц словами был в приложении и без этой правки', () => {
    expect(dayMonthShort(new Date(2026, 8, 25).getTime())).toBe('25 сен');
  });
});
