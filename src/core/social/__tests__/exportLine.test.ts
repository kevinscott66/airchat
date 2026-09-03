/**
 * Выгрузка переписки: непрочитанная реплика и оборванная страница (v4.32.604).
 *
 * Два сросшихся дефекта. Первый: `listAllChatMessages` отдавала обычный
 * список, и провалившаяся страница приходила пустой — то есть читалась как
 * конец переписки. Файл сохраняли и ссылались на него как на всю переписку,
 * а часть реплик в него не попадала. Второй: все три места экспорта клеили
 * `m.text` напрямую, и реплика, которую ключ устройства не открыл, уходила
 * строкой «[время] Имя: » — пустотой, неотличимой от отправленной пустоты.
 *
 * Тест держит и поведение `exportBody`, и форму трёх мест экспорта: копии уже
 * разошлись однажды (пометка вложения была в двух местах из трёх, вырезание
 * управляющих символов — в одном из трёх), поэтому форма и пришпилена.
 */
import fs from 'fs';
import path from 'path';

import {
  EXPORT_MEDIA_PREFIX,
  EXPORT_MEDIA_TEXT,
  EXPORT_UNREADABLE_TEXT,
  exportBody,
} from '../exportLine';

const MODULE = path.join(__dirname, '..', 'exportLine.ts');
const LOCAL = path.join(__dirname, '..', '..', 'storage', 'local.ts');
const CHAT = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx');
const GROUPS = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx');
const CONTACT = path.join(
  __dirname, '..', '..', '..', 'ui', 'components', 'modals', 'profile', 'ProfileChatBlock.tsx'
);
const SHARED = path.join(
  __dirname, '..', '..', '..', 'ui', 'components', 'modals', 'chat', 'ChatSharedMediaModal.tsx'
);

const moduleSrc = () => fs.readFileSync(MODULE, 'utf8');
const localSrc = () => fs.readFileSync(LOCAL, 'utf8');
const chatSrc = () => fs.readFileSync(CHAT, 'utf8');
const groupsSrc = () => fs.readFileSync(GROUPS, 'utf8');
const contactSrc = () => fs.readFileSync(CONTACT, 'utf8');
const sharedSrc = () => fs.readFileSync(SHARED, 'utf8');

/** Кусок исходника между двумя якорями — чтобы утверждение не ловило чужую функцию. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('exportBody: непрочитанная реплика не становится пустотой', () => {
  it('непрочитанная реплика получает пометку, а не пустую строку', () => {
    expect(exportBody({ text: '', unreadable: true })).toBe(EXPORT_UNREADABLE_TEXT);
    expect(exportBody({ text: '', unreadable: true })).not.toBe('');
  });

  it('«не открылось» проверяется раньше признака вложения', () => {
    // Иначе непрочитанное вложение выдало бы себя за обычное медиа.
    expect(exportBody({ text: EXPORT_MEDIA_PREFIX + 'x', unreadable: true }))
      .toBe(EXPORT_UNREADABLE_TEXT);
  });

  it('«не открылось» перекрывает и уцелевший текст', () => {
    expect(exportBody({ text: 'привет', unreadable: true })).toBe(EXPORT_UNREADABLE_TEXT);
  });

  it('признак читается строго по true, а не по правдоподобию', () => {
    expect(exportBody({ text: 'привет', unreadable: false })).toBe('привет');
    expect(exportBody({ text: 'привет' })).toBe('привет');
    expect(exportBody({ text: 'привет', unreadable: undefined })).toBe('привет');
  });

  it('пустая отправленная реплика остаётся пустой строкой', () => {
    // Разница между «нечего показывать» и «не смогли прочитать» и есть суть.
    expect(exportBody({ text: '' })).toBe('');
  });

  it('пометка не называет причину — про ключ в файле ни слова', () => {
    expect(EXPORT_UNREADABLE_TEXT).not.toMatch(/ключ|расшифр|decrypt|DEK/i);
  });

  it('пометка оформлена скобками, как принятая в файле пометка вложения', () => {
    expect(EXPORT_UNREADABLE_TEXT.startsWith('[')).toBe(true);
    expect(EXPORT_UNREADABLE_TEXT.endsWith(']')).toBe(true);
    expect(EXPORT_MEDIA_TEXT).toBe('[Медиа]');
  });
});

describe('exportBody: служебные символы не уезжают в файл', () => {
  it('служебный префикс превращается в пометку, а не пишется как есть', () => {
    expect(EXPORT_MEDIA_PREFIX).toBe('\u0001');
    expect(exportBody({ text: EXPORT_MEDIA_PREFIX + '{"cid":"a"}' })).toBe(EXPORT_MEDIA_TEXT);
    expect(exportBody({ text: EXPORT_MEDIA_PREFIX })).toBe(EXPORT_MEDIA_TEXT);
  });

  it('управляющие символы вырезаются из недоверенного текста', () => {
    expect(exportBody({ text: '\u0000абв' })).toBe('абв');
    // Префикс вложения не в начале строки — мусор, а не пометка.
    expect(exportBody({ text: 'аб\u0001в' })).toBe('абв');
  });

  it('перевод строки и табуляция уцелели — файл строчный', () => {
    expect(exportBody({ text: 'а\nб\tв\r' })).toBe('а\nб\tв\r');
  });

  it('нестрока и отсутствие строки дают пустоту, а не «undefined»', () => {
    expect(exportBody({ text: null })).toBe('');
    expect(exportBody({})).toBe('');
    expect(exportBody(null)).toBe('');
    expect(exportBody(undefined)).toBe('');
    expect(exportBody({ text: 42 as unknown as string })).toBe('');
  });
});

describe('модуль остаётся чистым', () => {
  it('ни одного импорта — значит проверяемо без хранилища и рендера', () => {
    const imports = moduleSrc().split('\n').filter((l) => /^import\s/.test(l));
    expect(imports).toHaveLength(0);
  });
});

describe('чтение переписки целиком: либо всё, либо ничего', () => {
  it('listAllChatMessages отдаёт трёхзначное чтение, а не просто список', () => {
    const body = slice(
      localSrc(),
      'export async function listAllChatMessages(',
      'export async function getChatMessageStats('
    );
    expect(body).toMatch(/Promise<DbRead<ChatMessageRow>>/);
    expect(body).toMatch(/if \(page === null\) return null;/);
  });

  it('страничный читатель отдаёт null при сбое, а не пустую страницу', () => {
    const body = slice(
      localSrc(),
      'async function listChatMessagesPage(',
      'export async function listAllChatMessages('
    );
    expect(body).toMatch(/Promise<ChatMessageRow\[\] \| null>/);
    expect(body).toMatch(/chat_messages_list_failed/);
    expect(body).toMatch(/catch \(e\) \{[\s\S]*return null;/);
    expect(body).not.toMatch(/catch \(e\) \{[\s\S]*return \[\];/);
  });

  it('публичный listChatMessages остался прежним для живого экрана', () => {
    // Договор «сбой = пустой список» этот раунд намеренно не трогает.
    const body = slice(localSrc(), 'export async function listChatMessages(', '/**');
    expect(body).toMatch(/Promise<ChatMessageRow\[\]>/);
    expect(body).toMatch(/listChatMessagesPage\(\{[^}]*\}\)\) \?\? \[\];/);
  });
});

describe('оба места выгрузки чата отказываются писать усечённый файл', () => {
  it('экран чата проверяет чтение до сборки строк', () => {
    const src = chatSrc();
    expect(src).toMatch(
      /^import \{ shouldApplyRows \} from '\.\.\/\.\.\/core\/storage\/readResult';$/m
    );
    const body = slice(src, 'const allMsgs = await listAllChatMessages(', 'shareTextExport(');
    expect(body).toMatch(
      /if \(!shouldApplyRows\(allMsgs\)\) \{ showError\('Не удалось прочитать переписку для экспорта'\); return; \}/
    );
    // Проверка стоит раньше сортировки: иначе сбой уже стал бы пустым файлом.
    expect(body.indexOf('shouldApplyRows(allMsgs)')).toBeLessThan(body.indexOf('.sort('));
  });

  it('карточка контакта проверяет чтение до заголовка с числом сообщений', () => {
    const src = contactSrc();
    expect(src).toMatch(
      /^import \{ shouldApplyRows \} from '\.\.\/\.\.\/\.\.\/\.\.\/core\/storage\/readResult';$/m
    );
    const body = slice(src, 'const msgs = await listAllChatMessages(', 'shareTextExport(');
    expect(body).toMatch(
      /if \(!shouldApplyRows\(msgs\)\) \{ showError\('Не удалось прочитать переписку для экспорта'\); return; \}/
    );
    // Заголовок обещает число сообщений — усечённый файл соврал бы дважды.
    expect(body.indexOf('shouldApplyRows(msgs)')).toBeLessThan(body.indexOf('Сообщений:'));
  });

  it('общие медиа не выдают сбой чтения за «ссылок и файлов нет»', () => {
    const src = sharedSrc();
    expect(src).toMatch(
      /^import \{ shouldApplyRows \} from '\.\.\/\.\.\/\.\.\/\.\.\/core\/storage\/readResult';$/m
    );
    const body = slice(
      src,
      'listAllChatMessages({ contactPubB64, ownerProfileId })',
      'for (const msg of msgs)'
    );
    expect(body).toMatch(/if \(!shouldApplyRows\(msgs\)\) return;/);
  });
});

describe('все три места выгрузки собирают тело одним кодом', () => {
  const sites: Array<[string, () => string, string]> = [
    ['экран чата', chatSrc, "import { exportBody } from '../../core/social/exportLine';"],
    ['группа', groupsSrc, "import { exportBody } from '../../core/social/exportLine';"],
    ['карточка контакта', contactSrc, "import { exportBody } from '../../../../core/social/exportLine';"],
  ];

  it.each(sites)('%s импортирует общий exportBody', (_name, read, imp) => {
    expect(read()).toContain(imp);
  });

  it('экран чата и группа пишут строку через exportBody', () => {
    expect(chatSrc()).toContain('return `[${d}] ${who}: ${exportBody(m)}`;');
    expect(groupsSrc()).toContain('return `[${d}] ${who}: ${exportBody(m)}`;');
  });

  it('карточка контакта пишет строку через exportBody', () => {
    expect(contactSrc()).toContain('lines.push(`[${ts}] ${sender}: ${exportBody(m)}`);');
  });

  it.each(sites)('%s больше не клеит текст сообщения напрямую', (_name, read) => {
    const src = read();
    // Прежние формы: текст сообщения прямо в строке файла.
    expect(src).not.toContain('${who}: ${m.text}');
    expect(src).not.toContain('${sender}: ${m.text}');
    // И локальные копии пометки вложения — теперь она одна на всех.
    expect(src).not.toContain("? '[Медиа]' :");
  });

  it('имя автора в группе по-прежнему идёт через outwardName', () => {
    // Пометка допустима в теле реплики, но не в поле имени — см. v4.32.593.
    const body = slice(groupsSrc(), 'const who = anonymousPosting', 'exportBody(m)');
    expect(body).toMatch(
      /outwardName\(m\.senderName, m\.senderUnreadable, shortIdentity\(m\.senderPubB64\)\)/
    );
  });
});
