/**
 * Лента больше не выдаёт пропавший файл за слишком большой (v4.32.843).
 *
 * Дефект. Чтение вложений отвечало одним словом — `null`, — и оно означало три
 * разных исхода: файла нет на месте, файл тяжелее предела, чтение сорвалось
 * исключением. Наверху их складывали в один счётчик `mediaDropped` и печатали:
 *
 *   «Не удалось отправить N фото: размер превышает лимит. Пост опубликован без них.»
 *
 * То есть человеку, у которого фотографию вычистил системный сборщик кэша,
 * советовали уменьшить файл. Совет невыполним: уменьшать нечего.
 *
 * Хуже того, документы не считались вообще: `if (read) docs.push(read)` — и
 * всё. Не прочитавшийся документ исчезал без единой цифры наверх и без слова
 * человеку. А запись из одних документов, ни один из которых не прочитался,
 * уходила в ленту пустой: без текста, без вложений, без причины.
 *
 * И третье: когда терялись все фотографии, наружу шло `tooLarge: true`, и лента
 * говорила «Пост слишком большой… уменьшите количество фото или сократите
 * текст» — над постом, в котором ничего большого не было.
 *
 * Цена. Та же, за которую правили пачку в v4.32.842 и личные сообщения в
 * v4.32.569: человек уверен, что опубликовал с вложением, вложения нет, а
 * названная причина уводит от настоящей.
 *
 * Правка. Причина отказа называется словом у самого чтения, считается порознь
 * для фотографий и документов, и наверх едет вся: `feedAttachLoss` говорит
 * только о том, что вправду случилось.
 */

import fs from 'fs';
import path from 'path';

import {
  NO_ATTACH_LOSS,
  attachLostCount,
  feedAttachLossText,
  type FeedAttachLoss,
} from '../feedAttachLoss';

const loss = (p: Partial<FeedAttachLoss>): FeedAttachLoss => ({ ...NO_ATTACH_LOSS, ...p });

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

/** Только код: комментарий, где написано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const FEED = codeOnly(read('core', 'social', 'feedService.ts'));
const SCREEN = codeOnly(read('ui', 'screens', 'FeedScreen.tsx'));
const RU = read('i18n', 'ru.json');

describe('называется та причина, которая случилась', () => {
  it('файл не прочитался — про размер не говорят ни слова', () => {
    const text = feedAttachLossText(loss({ photoFailed: 2 }), true);
    // ПРОВЕРКА НЕ ПУСТАЯ: сказано и сколько, и что именно.
    expect(text).not.toBeNull();
    expect(text).toContain('2 фото');
    expect(text).toContain('не прочитались');
    expect(text).not.toContain('большие');
    expect(text).not.toContain('лимит');
  });

  it('файл тяжелее предела — про это и говорят', () => {
    const text = feedAttachLossText(loss({ photoOversize: 1 }), true);
    expect(text).toContain('1 фото');
    expect(text).toContain('слишком большие');
    expect(text).not.toContain('не прочитались');
  });

  it('причины обе — названы обе, а не первая', () => {
    const text = feedAttachLossText(loss({ photoOversize: 1, docFailed: 1 }), true);
    expect(text).toContain('слишком большие или не прочитались');
  });

  it('документы считаются наравне с фотографиями и склоняются', () => {
    expect(feedAttachLossText(loss({ docFailed: 1 }), true)).toContain('1 документ —');
    expect(feedAttachLossText(loss({ docFailed: 2 }), true)).toContain('2 документа');
    expect(feedAttachLossText(loss({ docOversize: 5 }), true)).toContain('5 документов');
    expect(feedAttachLossText(loss({ docFailed: 11 }), true)).toContain('11 документов');
    expect(feedAttachLossText(loss({ docFailed: 21 }), true)).toContain('21 документ');
  });

  it('документы сверх предела на запись — тоже потеря, и о ней говорят', () => {
    const text = feedAttachLossText(loss({ docTooMany: 2 }), true);
    expect(text).toContain('2 документа');
    expect(text).toContain('сверх предела на одну запись');
    // Это не «слишком большой файл»: совет уменьшать его тут ничем не поможет.
    expect(text).not.toContain('слишком большие');
    expect(attachLostCount(loss({ docTooMany: 2 }))).toBe(2);
  });

  it('потеряно и то, и другое — перечислены оба', () => {
    const text = feedAttachLossText(loss({ photoFailed: 2, docOversize: 1 }), true);
    expect(text).toContain('2 фото и 1 документ');
  });

  it('запись всё же состоялась — человеку говорят, что писать заново не надо', () => {
    expect(feedAttachLossText(loss({ photoFailed: 1 }), true)).toContain(
      'Запись уже создана — публиковать заново не нужно.',
    );
    // «Создана», а не «опубликована»: она может ждать в очереди отправки, и
    // обещать ей ленту контактов тут не за что.
    expect(feedAttachLossText(loss({ photoFailed: 1 }), true)).not.toContain('опубликована');
    // А если не состоялась — про неё не говорят вовсе.
    expect(feedAttachLossText(loss({ photoFailed: 3 }), false)).not.toContain('Запись');
  });

  it('терять было нечего — молчат', () => {
    expect(feedAttachLossText(NO_ATTACH_LOSS, true)).toBeNull();
    expect(feedAttachLossText(NO_ATTACH_LOSS, false)).toBeNull();
    expect(attachLostCount(NO_ATTACH_LOSS)).toBe(0);
    expect(attachLostCount(loss({ photoOversize: 1, docFailed: 2 }))).toBe(3);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  /** Прежнее чтение: три исхода — один ответ. */
  const oldRead = (outcome: 'missing' | 'oversize' | 'threw'): null => {
    if (outcome === 'missing') return null;
    if (outcome === 'oversize') return null;
    return null;
  };

  it('пропажу файла и превышение предела различить было нечем', () => {
    expect(oldRead('missing')).toBe(oldRead('oversize'));
    expect(oldRead('threw')).toBe(oldRead('oversize'));
    // А теперь — есть чем: у каждой причины своё поле и свои слова.
    expect(feedAttachLossText(loss({ photoFailed: 1 }), true)).not.toBe(
      feedAttachLossText(loss({ photoOversize: 1 }), true),
    );
  });

  it('прежний текст называл размер на любой причине', () => {
    const oldDetail = (count: number): string =>
      `Не удалось отправить ${count} фото: размер превышает лимит. Пост опубликован без них.`;
    expect(oldDetail(2)).toContain('размер превышает лимит');
    // Ни одного превышения не было — а сказано про размер. Новый текст так не умеет.
    expect(feedAttachLossText(loss({ photoFailed: 2 }), true)).not.toContain('лимит');
    // И самой строки в приложении больше нет.
    expect(RU).not.toContain('размер превышает лимит');
    expect(RU).not.toContain('mediaDroppedDetail');
  });

  it('прежний цикл документов не считал потери — их некуда было положить', () => {
    const docsIn = ['ok', 'fail', 'fail'];
    const docsOut: string[] = [];
    for (const d of docsIn) {
      const r = d === 'ok' ? d : null;
      if (r) docsOut.push(r);
    }
    // Два документа исчезли, и разница видна только по длине, которую никто не сверял.
    expect(docsOut).toHaveLength(1);
    // Ровно поэтому в счёте теперь есть поля документов.
    expect(Object.keys(NO_ATTACH_LOSS)).toEqual(
      expect.arrayContaining(['docOversize', 'docFailed']),
    );
  });

  it('прежний отказ обещал человеку неправду про размер', () => {
    const oldTooLarge = 'Общий размер текста и медиа превышает лимит 1.8 МБ.';
    expect(oldTooLarge).toContain('превышает лимит');
    // Этот текст остаётся — но только там, где размер вправду превышен.
    expect(RU).toContain('postTooLargeDetail');
    // На потерянных вложениях говорят другое.
    expect(RU).toContain('"attachAllLost"');
  });
});

describe('форма исходников', () => {
  it('чтение вложения называет причину, а не возвращает null', () => {
    expect(FEED).toContain("type FeedReadFail = { ok: false; reason: 'oversize' | 'failed' }");
    expect(FEED).toContain(
      'Promise<{ ok: true; b64: string; mime: string } | FeedReadFail>',
    );
    expect(FEED).toContain(
      'Promise<{ ok: true; name: string; mime: string; size: number; b64: string } | FeedReadFail>',
    );
    // Пропавший файл — «не прочиталось», а не «слишком большое».
    expect(FEED).toContain("log.warn('feed_media_missing')");
    expect(FEED).toContain("log.warn('feed_doc_missing'");
  });

  it('каждая причина попадает в свой счётчик', () => {
    for (const field of ['photoOversize', 'photoFailed', 'docOversize', 'docFailed']) {
      expect(FEED).toContain(`loss.${field} += 1`);
    }
    expect(FEED).not.toContain('mediaDropped += 1;');
    // Отрезанные пределом документы — тоже в счёт, а не в пустоту.
    expect(FEED).toContain('loss.docTooMany = opts.documents.length - limited.length;');
    expect(FEED).toContain("log.warn('feed_docs_over_limit'");
  });

  it('запись из одних непрочитанных вложений больше не уходит пустой', () => {
    // Проверка стоит ПОСЛЕ чтения документов — иначе про них она ничего не знает.
    const atDocs = FEED.indexOf('const read = await readDocumentAsBase64(input);');
    const atGuard = FEED.indexOf('attachLostCount(loss) > 0');
    expect(atDocs).toBeGreaterThan(-1);
    expect(atGuard).toBeGreaterThan(atDocs);
    expect(FEED).toContain(
      'if (attachLostCount(loss) > 0 && media.length === 0 && docs.length === 0 && !text) {',
    );
    expect(FEED).toContain('return { postId: null, attachAllLost: true, mediaDropped, attachLoss: loss };');
    // Прежняя проверка стояла до документов и врала про размер.
    expect(FEED).not.toContain("log.warn('feed_publish_all_media_too_large'");
  });

  it('исход «вложения не дошли» доезжает до экрана отдельно от размера', () => {
    expect(FEED).toContain("'empty' | 'too_large' | 'offline' | 'other' | 'attachments'");
    expect(FEED).toContain("return { ok: false, reason: 'attachments'");
    expect(SCREEN).toContain(
      "import { feedAttachLossText } from '../../core/social/feedAttachLoss';",
    );
    expect(SCREEN).toContain("if (result.reason === 'attachments') {");
    expect(SCREEN).toContain("Alert.alert(t('feed.attachPartial'), lostText);");
    // Прежний текст про лимит на этой ветке больше не зовут.
    expect(SCREEN).not.toContain('feed.mediaDroppedDetail');
    expect(SCREEN).not.toContain('feed.mediaPartialSkipped');
  });

  it('счёт и слова живут отдельно от файловой системы', () => {
    const mod = codeOnly(read('core', 'social', 'feedAttachLoss.ts'));
    const imports = mod.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(["import { ruPlural } from '../text/ruPlural';"]);
    expect(mod).toContain('export function feedAttachLossText(');
  });
});
