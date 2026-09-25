/**
 * Единственная строка раздела OpenFlux, что вне режима разработчика, говорила
 * причиной, а не делом (v4.32.953).
 *
 * Дефект. Когда туннель поднят, но перехват HTTP промахнулся мимо своего порта,
 * раздел показывал: «Перехват запросов не встал: их порт заняли раньше нас, и
 * запросы приложения идут напрямую, мимо туннеля. Перезапуск приложения обычно
 * это чинит». Строка намеренно стоит НЕ за devMode — и правильно стоит: это
 * единственное место, где человек вообще может узнать, что «Включён» не
 * означает «трафик пошёл через туннель». Но два слова из трёх в ней — «порт»
 * и «перехват» — обычному человеку не значат ничего.
 *
 * Цена. Человек включил туннель именно затем, чтобы трафик шёл не напрямую.
 * Ему сообщают о неудаче словами, из которых он не понимает ни что случилось,
 * ни что делать; а сделать как раз есть что.
 *
 * Правка. Та же строка говорит следствие и действие: трафик идёт напрямую,
 * помогает перезапуск. Причина осталась в комментарии рядом — она нужна тому,
 * кто читает исходник, и никому больше: переставить перехват всё равно нельзя,
 * RN спрашивает конфигурацию сессии один раз за жизнь процесса.
 *
 * Границы. Проверяется ровно эта ветка — та, что рисуется при
 * `status === 'on' && httpLayer === false`. Инженерные строки НИЖЕ неё стоят за
 * `devMode` и вправе говорить «SOCKS5», «перехват» и «ядро»: их читает тот, кто
 * семь раз нажал на номер версии.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SECTION = readFileSync(
  join(__dirname, '..', 'OpenFluxSettingsSection.tsx'),
  'utf8',
);

/** Исходник без комментариев: прежние слова процитированы в пояснении. */
function codeOnly(src: string): string {
  return src
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

const CODE = codeOnly(SECTION);

/** Ветка «туннель поднят, а запросы идут мимо» целиком. */
function bypassBranch(code: string): string {
  const head = "{status === 'on' && httpLayer === false ? (";
  const from = code.indexOf(head);
  if (from === -1) return '';
  const to = code.indexOf(') : null}', from);
  return to === -1 ? '' : code.slice(from, to);
}

const BRANCH = bypassBranch(CODE);

/**
 * Сама надпись — то, что человек прочтёт. Имена стилей внутри тега к делу не
 * относятся: `styles.socks` человеку не показывают.
 */
function visibleText(branch: string): string {
  const open = branch.indexOf('>', branch.indexOf('<Text'));
  const close = branch.indexOf('</Text>', open);
  return open === -1 || close === -1 ? '' : branch.slice(open + 1, close).trim();
}

const TEXT = visibleText(BRANCH);

describe('ПРОВЕРКА НЕ ПУСТАЯ: ветка нашлась и в ней есть текст', () => {
  it('условие ветки на месте, и надпись из неё вынулась', () => {
    expect(BRANCH).not.toBe('');
    expect(BRANCH).toContain('<Text');
    expect(TEXT.length).toBeGreaterThan(40);
  });

  it('разбор комментариев не съел код', () => {
    expect(CODE).toContain('const STATUS_LABEL');
    expect(codeOnly('/* порт */\nconst a = 1;')).not.toContain('порт');
  });

  it('инженерные строки в файле никуда не делись', () => {
    expect(CODE).toContain('Локальный SOCKS5:');
  });
});

describe('строка вне режима разработчика говорит делом', () => {
  it('сказано следствие: трафик идёт мимо туннеля', () => {
    expect(TEXT).toContain('запросы приложения идут мимо него — напрямую');
  });

  it('сказано действие: перезапустить приложение', () => {
    expect(TEXT).toContain('перезапустите приложение');
  });

  it('слов разработчика в надписи не осталось', () => {
    for (const word of ['порт', 'перехват', 'SOCKS', 'HTTP', 'прокси', 'ядро']) {
      expect(TEXT.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('строка по-прежнему НЕ за режимом разработчика', () => {
    const head = CODE.indexOf("{status === 'on' && httpLayer === false ? (");
    const before = CODE.slice(0, head);
    // Ближайший devMode-затвор открывается ПОСЛЕ этой ветки, а не до неё.
    expect(before.lastIndexOf('{devMode && socks')).toBeLessThan(head);
    expect(BRANCH).not.toContain('devMode');
  });

  it('инженерный блок ниже остаётся за devMode и слова разработчика ему можно', () => {
    const proof = CODE.slice(CODE.indexOf('{devMode && stats ? ('));
    expect(proof).toContain('ядро');
    expect(proof).toContain('Перехват:');
  });

  it('«Включён» по-прежнему не обещает, что трафик пошёл', () => {
    expect(SECTION).toContain("on: 'Включён',");
  });
});
