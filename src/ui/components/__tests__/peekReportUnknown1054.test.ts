/**
 * ДЕФЕКТ (v4.32.1054). Карточка человека подписывала пункт «Пожаловаться» и
 * подсвечивала его как опасное действие там, где журнал жалоб прочитать не
 * удалось, — в том числе над теми, на кого человек уже пожаловался.
 *
 * `readReports` в `contactReport.ts` различает три исхода честно: `null`, если
 * ячейка не прочиталась или чтение бросило. А `listContactReports` сводит
 * отказ к пустому журналу (`?? []`), и прежний `hasReported` считал по нему:
 * «жалоб нет» — значит `false`.
 *
 * ЦЕНА. Жалоба — собственное прошлое действие человека, и приложение
 * рассказывало о нём догадку. Подпись «Жалоба записана» существует ровно
 * затем, чтобы не жаловаться дважды; вместо неё на непрочитанном журнале
 * показывался красный призыв пожаловаться. При этом запись такой ошибки уже не
 * делает: с v4.32.695 `recordContactReport` на `prev === null` бросает, чтобы
 * не затереть прежний след. То есть человек, поверивший подписи и нажавший,
 * получал отказ — но узнавал об этом только после нажатия.
 *
 * ПРАВКА. `hasReportedRead` отвечает третьим словом (`null`) прямо из
 * `readReports`. Карточка держит `reportUnknown` и подписывает пункт
 * «Пожаловаться (журнал не прочитался)» — тем же приёмом, что уже принят для
 * списка запретов (v4.32.1051), книги контактов (v4.32.1052) и разговора
 * (v4.32.1053).
 *
 * ГРАНИЦЫ. Пункт остаётся нажимаемым: журнал мог и не содержать жалобы, а
 * отнимать у человека возможность пожаловаться из-за занятой базы дороже
 * неточной подписи; попытка записи упрётся в защиту v4.32.695 и скажет об этом
 * сама. `danger` тоже остаётся: он описывает опасность самого действия, а не
 * то, делали ли его раньше. `listContactReports` не трогаем — он двузначен
 * намеренно, список жалоб показать пустым не страшно.
 */
import fs from 'fs';
import path from 'path';

import { hubSettings, type HubFacts } from '../profileHubModel';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from); if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = src.indexOf(to, a); if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

const PEEK = () => read('ui', 'components', 'UserProfilePeek.tsx');
const JOURNAL = () => read('core', 'social', 'contactReport.ts');

const facts: HubFacts = {
  isSelf: false,
  inContacts: true,
  hasContactRecord: true,
  bookUnknown: false,
  blocked: false,
  blockUnknown: false,
  muted: false,
  copyGuard: false,
  copyGuardByPeer: false,
  copyGuardUnknown: false,
  disappearMs: null,
  convUnknown: false,
  reported: false,
  reportUnknown: false,
  canOpenChat: true,
  inChat: false,
};

const report = (f: HubFacts) => hubSettings(f).find((i) => i.id === 'report');

describe('что карточка говорит о жалобе', () => {
  it('непрочитанный журнал не выдаётся за «не жаловался»', () => {
    expect(report({ ...facts, reportUnknown: true })?.label)
      .toBe('Пожаловаться (журнал не прочитался)');
  });

  it('ГРАНИЦА: прочитанный журнал без жалобы — прежнее «Пожаловаться»', () => {
    expect(report({ ...facts, reported: false, reportUnknown: false })?.label).toBe('Пожаловаться');
  });

  it('ГРАНИЦА: поданная жалоба перевешивает незнание', () => {
    expect(report({ ...facts, reported: true, reportUnknown: true })?.label).toBe('Жалоба записана');
  });

  it('ГРАНИЦА: пункт при незнании не отнимаем — пожаловаться человек вправе', () => {
    expect(report({ ...facts, reportUnknown: true })?.disabled).toBeFalsy();
  });

  it('ГРАНИЦА: опасным пункт остаётся — это про действие, а не про прошлое', () => {
    expect(report({ ...facts, reportUnknown: true })?.danger).toBe(true);
  });

  it('подпись называет причину незнания, а не «ошибку»', () => {
    const label = report({ ...facts, reportUnknown: true })?.label ?? '';
    expect(label).toContain('журнал');
    expect(label).not.toMatch(/ошибк|error|fail/i);
  });
});

describe('карточка читает различающим чтением', () => {
  it('зовёт hasReportedRead, а не прежний двузначный hasReported', () => {
    const peek = PEEK();
    expect(peek).toContain('hasReportedRead(resolved.did)');
    expect(peek).not.toContain('hasReported(');
  });

  it('`null` разводится в отдельное состояние, а не в «не жаловался»', () => {
    const peek = PEEK();
    expect(peek).toContain('setReportUnknown(wasReported === null)');
    expect(peek).toContain('setReported(wasReported === true)');
  });

  it('незнание сбрасывается при смене собеседника', () => {
    expect(PEEK()).toContain('setReportUnknown(false)');
  });

  it('факт доезжает до подписи пункта', () => {
    expect(PEEK()).toContain('reportUnknown,');
    expect(read('ui', 'components', 'profileHubModel.ts')).toContain('f.reportUnknown');
  });

  it('сам журнал отвечает третьим словом из readReports, а не из списка', () => {
    const fn = slice(JOURNAL(), 'export async function hasReportedRead', '\n}');
    expect(fn).toContain('await readReports()');
    expect(fn).toContain('all === null ? null');
    expect(fn).not.toContain('listContactReports');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('пункт жалобы вообще есть в настройках карточки', () => {
    expect(report(facts)).toBeTruthy();
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: listContactReports по-прежнему гасит отказ', () => {
    const fn = slice(JOURNAL(), 'export async function listContactReports', '\n}');
    expect(fn).toContain('?? []');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: readReports различает отказ', () => {
    const fn = slice(JOURNAL(), 'async function readReports', '\n}');
    expect(fn).toContain('read === null ? null');
    expect(fn).toContain('return null');
  });

  it('ЗАКРЕПКА: запись жалобы на непрочитанном журнале по-прежнему бросает', () => {
    const src = JOURNAL();
    expect(src).toContain("if (prev === null)");
    expect(slice(src, 'export async function recordContactReport', '\n}')).toContain('throw new Error(');
  });

  it('ГРАНИЦА: у себя пункта жалобы нет ни при каком незнании', () => {
    expect(report({ ...facts, isSelf: true, reportUnknown: true })).toBeFalsy();
  });
});
