/**
 * v4.32.876. В «Общих медиа» снимок, который не скачался, исчезал из сетки.
 *
 * Дефект. Обе галереи — личная и групповая — рисовали плитку так: адреса нет,
 * значит `return null`. Адреса нет в двух совершенно разных случаях: вложение
 * ещё качается и вложение не скачалось. В обоих плитки не было вовсе.
 *
 * Цена. Сетка трёхколоночная и позиционная: пропавшая плитка сдвигает все
 * следующие, поэтому человек видел не «одного снимка нет», а другую галерею —
 * с чужими соседями и другим порядком. Число под списком («Показать всё · N»)
 * при этом считало строки, а не плитки, и не сходилось с тем, что на экране.
 * Сказано не было ничего, повторить было нечем: вложения для человека просто
 * не существовало.
 *
 * Правка. Место в сетке занято всегда, как это уже сделано для строки, которую
 * не открыл ключ (v4.32.584), и для одноразового (v4.32.803). Пока качается —
 * индикатор; не скачалось — отдельная плитка, по нажатию называет причину
 * словами (blobResolveText) и запускает повтор. Строки без вложения и строки
 * за потолком в 300 адресов плитки по-прежнему не получают: их и не обещали.
 */
import fs from 'fs';
import path from 'path';

import { galleryFirstCids, galleryCids, GALLERY_CID_LIMIT } from '../../../../../core/media/galleryCids';
import { blobResolveText } from '../../../../../core/media/blobResolveText';

const MODALS = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(MODALS, rel), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const CHAT = (): string => codeOnly(read('chat/ChatSharedMediaModal.tsx'));
const GROUP = (): string => codeOnly(read('groups/GroupSharedMediaModal.tsx'));
const BOTH = (): Record<string, string> => ({ 'личная': CHAT(), 'групповая': GROUP() });

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('обе галереи на месте и берут адреса из общего разбора', () => {
    for (const [name, src] of Object.entries(BOTH())) {
      expect([name, src.includes("from '../../../screens/chat-components/useResolvedMediaUrls'")])
        .toEqual([name, true]);
      expect([name, src.includes('resizeMode="cover"')]).toEqual([name, true]);
      expect([name, src.length > 3000]).toEqual([name, true]);
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('сетка позиционная: пустое место в списке оставлено намеренно', () => {
    const rows = [
      { mediaCids: '["a"]', text: null },
      { mediaCids: '["b"]', text: JSON.stringify({ t: 'vo', v: 1 }) },
      { mediaCids: '["c"]', text: null },
    ];
    const first = galleryFirstCids(rows as never);
    expect(first.length).toBe(3);
    // Пропусти вторую строку — и третий снимок встал бы на место второго.
    expect(first[0]).toBe('a');
    expect(first[2]).toBe('c');
  });

  it('у личной галереи есть потолок — за ним адреса нет, и это не отказ', () => {
    const many = Array.from({ length: GALLERY_CID_LIMIT + 5 }, (_, i) => ({ mediaCids: `["c${i}"]`, text: null }));
    expect(galleryCids(many as never).length).toBe(GALLERY_CID_LIMIT);
  });

  it('причина отказа переводится в слова — плитке есть что сказать', () => {
    expect(blobResolveText('offline', 'photo')).toContain('Попробуйте ещё раз');
    expect(blobResolveText('gone', 'photo')).toContain('больше не хранится');
    expect(blobResolveText('offline', 'photo')).not.toBe(blobResolveText('gone', 'photo'));
  });
});

describe('плитка больше не исчезает', () => {
  it('прежнего немого выхода по «нет адреса» не осталось ни в одной галерее', () => {
    for (const [name, src] of Object.entries(BOTH())) {
      expect([name, src.includes('if (!uri) return null;')]).toEqual([name, false]);
    }
  });

  it('пока качается — индикатор, а не пустое место', () => {
    for (const [name, src] of Object.entries(BOTH())) {
      expect([name, src.includes("slot?.phase !== 'failed'")]).toEqual([name, true]);
      expect([name, src.includes('<ActivityIndicator size="small" color={colors.textMuted} />')])
        .toEqual([name, true]);
    }
  });

  it('не скачалось — своя плитка, причина по нажатию и повтор', () => {
    const chat = CHAT();
    expect(chat).toContain("showError(blobResolveText(slot.reason ?? 'unknown', 'photo'));");
    expect(chat).toContain('retry();');
    expect(chat).toContain('accessibilityLabel={CSM_TILE_FAILED_HINT}');
    const group = GROUP();
    expect(group).toContain("showError(blobResolveText(slot.reason ?? 'unknown', 'photo'));");
    expect(group).toContain('retryThumbs();');
    expect(group).toContain('accessibilityLabel={GSM_TILE_FAILED_HINT}');
  });

  it('подпись плитки отказа сказана словами и обещает повтор', () => {
    for (const [name, src] of Object.entries(BOTH())) {
      const hint = /const (?:CSM|GSM)_TILE_FAILED_HINT = '([^']+)';/.exec(src)?.[1] ?? '';
      expect([name, hint]).toEqual([name, expect.stringContaining('не загрузился')]);
      expect([name, hint]).toEqual([name, expect.stringContaining('повторить')]);
    }
  });

  it('то, чего и не обещали, плитки по-прежнему не получает', () => {
    // Личная: адрес за потолком в 300 — его нет в списке разбора.
    expect(CHAT()).toContain('const at = allCids.indexOf(first);\n    if (at < 0) return null;');
    // Групповая: строка без единого вложения.
    expect(GROUP()).toContain('if (!firstCids[index]) return null;');
  });

  it('разбор берётся слотами, а не голыми адресами', () => {
    expect(CHAT()).toContain('const { slots, retry } = useResolvedMediaSlots(allCids, gateway);');
    expect(GROUP()).toContain('const { slots: thumbSlots, retry: retryThumbs } = useResolvedMediaSlots(firstCids, gateway);');
  });
});
