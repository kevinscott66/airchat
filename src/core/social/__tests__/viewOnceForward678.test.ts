/**
 * v4.32.678. Пересылка одноразового сообщения выносила его подпись наружу.
 *
 * '\x09vo:' сознательно не входил в MACHINE_PREFIXES: комментарий обещал, что
 * «экран сам снимает префикс при отрисовке». Снимал его ровно один экран —
 * ChatScreen (личка). Экран групп разбирает пересылку своей веткой
 * (GroupsScreen.tsx: `const displayText = fwdInfo ? fwdInfo.originalText : item.text`)
 * и проверки на '\x09vo:' в ней нет вовсе; собственная ветка одноразового у
 * него живёт под `item.mediaCids`, а пересылка вложения не копирует. То есть
 * пересланное в группу одноразовое рисовалось сырой строкой «\tvo:подпись».
 *
 * Но разметка здесь — меньшая часть. Подпись одноразового во всём остальном
 * коде считается тем, чему не место в постоянной истории: searchableText
 * вырезает её из индекса целиком, messagePreview показывает вместо неё
 * «🔥 Одноразовое сообщение». Пересылка была единственной дверью, через
 * которую подпись отправителя оседала у третьего лица навсегда — и текстом в
 * пузыре лички, и строкой в поиске получателя.
 *
 * Правка одна и в одном месте: '\x09vo:' дописан в MACHINE_PREFIXES, поэтому
 * подмена работает и на сборке (makeForwardText, makeForwardBundleText), и на
 * разборе (parseForwardedMessage) — последнее важно для строк, которые собрал
 * чужой или старый клиент.
 */
import fs from 'fs';
import path from 'path';

import {
  FORWARD_PREFIX,
  makeForwardText,
  makeForwardBundleText,
  parseForwardedMessage,
} from '../forwardEnvelope';
import { previewLabelForText } from '../messagePreview';
import { searchableText } from '../searchableText';

const VO = '\x09vo:';
const CAPTION = 'секретная подпись';
const LABEL = '🔥 Одноразовое сообщение';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const GROUPS = (): string => read('ui/screens/GroupsScreen.tsx');

/** Убирает строки-комментарии, чтобы русский текст правки не подтверждал сам себя. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('повод для правки жив', () => {
  it('экран групп по-прежнему рисует тело пересылки как есть', () => {
    const code = codeOnly(GROUPS());
    expect(code).toContain('const displayText = fwdInfo ? fwdInfo.originalText : item.text;');
  });

  it('и снять префикс сам не умеет — helper одноразового в него не импортируется', () => {
    // Импортируется только сборка конверта, разбора/снятия префикса нет.
    expect(GROUPS()).toContain("import { makeViewOnceText } from './chat-utils/viewOnce';");
    expect(GROUPS()).not.toContain('stripViewOncePrefix');
  });

  it('своя ветка одноразового у экрана групп требует вложения, которого у пересылки нет', () => {
    const code = codeOnly(GROUPS());
    const i = code.indexOf("item.text && item.text.startsWith('\\x09vo:')");
    expect(i).toBeGreaterThan(0);
    // Ветка стоит под проверкой item.mediaCids, а пересылка mediaCids не копирует.
    expect(code.slice(0, i)).toContain(') : item.mediaCids ? (');
  });

  it('подпись одноразового по-прежнему вырезана из поиска — ради этого всё и делается', () => {
    expect(searchableText(`${VO}${CAPTION}`)).toBe('');
    expect(previewLabelForText(`${VO}${CAPTION}`)).toBe(LABEL);
  });
});

describe('пересылка одноразового едет подписью', () => {
  it('сборка не кладёт подпись автора в конверт', () => {
    const fwd = makeForwardText('Аня', `${VO}${CAPTION}`);
    expect(fwd).not.toContain(CAPTION);
    expect(fwd).not.toContain(VO);
    expect(parseForwardedMessage(fwd)?.originalText).toBe(LABEL);
  });

  it('разбор подменяет и то, что собрал чужой клиент', () => {
    const raw = `${FORWARD_PREFIX}Аня\n${VO}${CAPTION}`;
    const p = parseForwardedMessage(raw);
    expect(p?.senderName).toBe('Аня');
    expect(p?.originalText).toBe(LABEL);
  });

  it('пересылка без имени — тоже подписью', () => {
    expect(parseForwardedMessage(`${FORWARD_PREFIX}${VO}${CAPTION}`)?.originalText).toBe(LABEL);
  });

  it('пачка сообщений не протаскивает подпись мимо подмены', () => {
    const bundle = makeForwardBundleText([
      { senderName: 'Аня', text: `${VO}${CAPTION}` },
      { senderName: 'Боря', text: 'обычный текст' },
    ]);
    expect(bundle).not.toContain(CAPTION);
    expect(bundle).toContain(`Аня: ${LABEL}`);
    expect(bundle).toContain('Боря: обычный текст');
  });

  it('пачка из одного сообщения идёт обычной пересылкой и тоже подменяется', () => {
    const bundle = makeForwardBundleText([{ senderName: 'Аня', text: `${VO}${CAPTION}` }]);
    expect(bundle).toBe(makeForwardText('Аня', `${VO}${CAPTION}`));
    expect(bundle).not.toContain(CAPTION);
  });

  it('пересылка пересылки одноразового не восстанавливает подпись', () => {
    const once = makeForwardText('Аня', `${VO}${CAPTION}`);
    const twice = makeForwardText('Боря', once);
    expect(twice).not.toContain(CAPTION);
    expect(parseForwardedMessage(twice)?.senderName).toBe('Аня');
    expect(parseForwardedMessage(twice)?.originalText).toBe(LABEL);
  });

  it('подпись не попадает и в поисковый индекс получателя', () => {
    const fwd = makeForwardText('Аня', `${VO}${CAPTION}`);
    const idx = searchableText(fwd);
    expect(idx).not.toContain(CAPTION);
    expect(idx).toContain('Аня');
  });
});

describe('проверка не пустая', () => {
  it('обычный текст пересылается без изменений', () => {
    const fwd = makeForwardText('Аня', 'обычная подпись');
    expect(parseForwardedMessage(fwd)?.originalText).toBe('обычная подпись');
  });

  it('текст, лишь похожий на префикс одноразового, не подменяется', () => {
    // Без двоеточия это не конверт.
    const fwd = makeForwardText('Аня', '\x09vo подпись');
    expect(parseForwardedMessage(fwd)?.originalText).toBe('\x09vo подпись');
  });

  it('соседние подмены на месте — список префиксов не подменён целиком', () => {
    expect(parseForwardedMessage(makeForwardText('А', '\x01voice:{}'))?.originalText).toBe(
      '🎤 Голосовое сообщение'
    );
    expect(parseForwardedMessage(makeForwardText('А', '\x0bsys:Звонок завершён'))?.originalText).toBe(
      'Звонок завершён'
    );
  });

  it('исходники экрана групп прочитаны, а не пустая строка', () => {
    expect(GROUPS().length).toBeGreaterThan(100_000);
    expect(codeOnly('// абв\nconst a = 1;\n')).toBe('const a = 1;\n');
  });
});
