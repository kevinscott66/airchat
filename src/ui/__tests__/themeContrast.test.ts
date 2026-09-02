/**
 * Контраст палитр по WCAG 2.1.
 *
 * Светлая тема год лежала непроверенной: её цвета брались из iOS HIG, где
 * #FF3B30 / #FF9F0A / #30D158 — это ЗАЛИВКА, а в коде ими пишут текст. На белом
 * фоне получалось 1.8–3.2:1 (порог для текста — 4.5:1), то есть «Сейчас онлайн»
 * и статус VPN читались с трудом или не читались совсем. Точно так же
 * `#7ecbff` — цвет ссылок и галочки «прочитано», вписанный руками в 19 мест, —
 * давал на белом 1.8:1.
 *
 * Формула контраста продублирована здесь намеренно: тест должен проверять
 * палитру, а не совпадать с ней в общей ошибке.
 */
import { Appearance } from 'react-native';
import { bannerColors } from '../components/StatusBanner';
import { ACCENT_SWATCHES, BRAND_X, MAP_PAPER, MENU_ICON_HUES, QR_CODE, STORY_TEXT_BACKGROUNDS, STORY_TEXT_VIEWER_BG, accentOnFill, applyAccent, badgeTint, bubbleInk, bubbleSurface, bubbleSurfaceOn, callTone, colorsForScheme, contrastRatio, contrastingInk, darkColors, fadedOn, identityAvatar, identityFill, identityHue, identityInk, inkOn, lightColors, mediaScrim, nestedFill, normalizeAccent, pollInk, primaryInk, readableInk, reactionInk, readableOn, resolveColors, resolveScheme, rippleOn, rowMark, scrim, searchMark, spoilerPlate, switchTone, tintedIcon, tintedPlate, toastSurface, withAlpha, type AppColors, type BadgeTone, type CallPhase, type FillInk, type MenuIconHue, type PollInk } from '../theme';
import type { AdminLogTone } from '../../core/social/groupAdminLog';
import { WALLPAPER_MESHES, WALLPAPER_PRESETS, feedGround, meshById, type Wallpaper } from '../wallpapers';

/** Относительная яркость sRGB, WCAG 2.1 §relative luminance. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((raw) => {
    const v = raw / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Коэффициент контраста двух цветов, 1:1 … 21:1. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Наложение `fg` с прозрачностью `alpha` на непрозрачный `bg`. */
function mix(fg: string, bg: string, alpha: number): string {
  const f = parseInt(fg.slice(1), 16);
  const b = parseInt(bg.slice(1), 16);
  const ch = (shift: number) =>
    Math.round((((f >> shift) & 255) * alpha) + (((b >> shift) & 255) * (1 - alpha)));
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('');
}

const palettes: [string, AppColors][] = [
  ['тёмная', darkColors],
  ['светлая', lightColors],
];

/** Все три фона, на которых реально оказывается текст. */
const surfacesOf = (p: AppColors) => [
  ['background', p.background],
  ['surface', p.surface],
  ['surfaceHigh', p.surfaceHigh],
] as const;

describe('контраст палитр', () => {
  it('формула считает известные значения (проверка самого теста)', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // Оба порядка аргументов дают один результат.
    expect(contrast('#0068D6', '#ffffff')).toBeCloseTo(contrast('#ffffff', '#0068D6'), 5);
  });

  describe.each(palettes)('%s тема', (_name, p) => {
    it.each(['text', 'textSecondary'] as const)('%s читается на всех фонах (4.5:1)', (token) => {
      for (const [surfaceName, bg] of surfacesOf(p)) {
        // Имя фона в сообщении об ошибке: иначе непонятно, какой из трёх упал.
        expect([surfaceName, contrast(p[token], bg) >= 4.5]).toEqual([surfaceName, true]);
      }
    });

    it('textMuted — подпись, а не основной текст: порог 3:1', () => {
      // 4.5:1 для третьего уровня серого на светлом фоне недостижимо, не
      // схлопнув его с textSecondary. 3:1 — порог WCAG для не-основного
      // содержимого, и обе темы его держат с запасом.
      for (const [, bg] of surfacesOf(p)) {
        expect(contrast(p.textMuted, bg)).toBeGreaterThanOrEqual(3);
      }
    });

    it.each(['accent', 'error', 'warning', 'success'] as const)(
      '%s используется как цвет текста и держит 4.5:1',
      (token) => {
        for (const [, bg] of surfacesOf(p)) {
          expect(contrast(p[token], bg)).toBeGreaterThanOrEqual(4.5);
        }
      }
    );

    it('звезда «в избранном» видна на всех фонах (3:1)', () => {
      // Знак, а не текст: порог WCAG для графики. Прежнее '#f9a825' было
      // написано руками в десяти местах и на белом фоне светлой темы давало
      // 1.9:1 — звезду там было не видно вовсе.
      for (const [surfaceName, bg] of surfacesOf(p)) {
        expect([surfaceName, contrast(p.star, bg) >= 3]).toEqual([surfaceName, true]);
      }
    });

    it('всё содержимое исходящего пузыря читается на его заливке', () => {
      // Пузырь — такая же поверхность, как остальные, и до 386-го он был
      // единственной, чьё содержимое палитре не подчинялось: цвета стояли
      // литералами под посылкой «пузырь тёмный в обеих темах». В светлой теме
      // он #0068D6, и на нём те же значения давали 1.63:1 у галочек статуса.
      const ink = bubbleInk(p);
      const text: (keyof FillInk)[] = ['text', 'secondary'];
      const graphic: (keyof FillInk)[] = ['muted', 'accent', 'error', 'star', 'success'];
      for (const k of text) {
        expect([k, contrast(ink[k], p.bubbleOut) >= 4.5]).toEqual([k, true]);
      }
      for (const k of graphic) {
        // Значок различим по форме, а не по надписи — порог для графики.
        expect([k, contrast(ink[k], p.bubbleOut) >= 3]).toEqual([k, true]);
      }
    });

    it('содержимое группового пузыря читается на ЛЮБОМ выбранном акценте', () => {
      // Исходящий пузырь в группе залит не `bubbleOut`, а `primary` — то есть
      // цветом из настроек. До 398-го всё внутри него было написано белым
      // руками: '#fff' у текста и 'rgba(255,255,255,0.5…0.85)' у времени,
      // галочек и подписей. Полупрозрачный белый на #3d5afe даёт 2.8:1 —
      // времени в собственном сообщении не видно и в тёмной теме, а на светлом
      // акценте пропадает остальное.
      const text: (keyof FillInk)[] = ['text', 'secondary'];
      const graphic: (keyof FillInk)[] = ['muted', 'accent', 'error', 'star', 'success'];
      for (const swatch of ACCENT_SWATCHES) {
        const primary = normalizeAccent(swatch.hex)!;
        const ink = primaryInk({ ...p, primary });
        for (const k of text) {
          expect([swatch.name, k, contrast(ink[k], primary) >= 4.5]).toEqual([swatch.name, k, true]);
        }
        for (const k of graphic) {
          expect([swatch.name, k, contrast(ink[k], primary) >= 3]).toEqual([swatch.name, k, true]);
        }
      }
    });

    it('плитка внутри группового пузыря заметна и на любом акценте', () => {
      // Плёнка «один просмотр» и ячейка фотосетки были залиты постоянной
      // 'rgba(255,255,255,0.12)': на светлом акценте она сливается с пузырём.
      for (const swatch of ACCENT_SWATCHES) {
        const primary = normalizeAccent(swatch.hex)!;
        const tile = nestedFill(primary);
        const ink = inkOn({ ...p, primary }, tile, contrastingInk(tile));
        expect([swatch.name, contrast(tile, primary) > 1.1]).toEqual([swatch.name, true]);
        expect([swatch.name, contrast(ink.secondary, tile) >= 4.5]).toEqual([swatch.name, true]);
        expect([swatch.name, contrast(ink.muted, tile) >= 3]).toEqual([swatch.name, true]);
      }
    });

    it('вложенный блок читается на любой из своих поверхностей', () => {
      // Блок цитаты лежит то в исходящем пузыре, то во входящем, то на фоне
      // ленты. До 387-го он был залит постоянной 'rgba(61,90,254,0.12)' — и
      // текст в нём давал 1.8–2.1:1 в светлой теме, то есть прочитать, на что
      // отвечают, было нельзя нигде.
      for (const host of [p.bubbleOut, p.surface, p.surfaceHigh, p.background]) {
        const fill = nestedFill(host);
        const ink = inkOn(p, fill);
        // Блок должен быть заметен на своей поверхности, но не за счёт текста.
        expect([host, contrast(fill, host) > 1.1]).toEqual([host, true]);
        expect([host, contrast(ink.secondary, fill) >= 4.5]).toEqual([host, true]);
        expect([host, contrast(ink.accent, fill) >= 3]).toEqual([host, true]);
      }
    });

    it('вложенный блок уходит от чернил, если к ним места нет', () => {
      // Обычно вложенный блок двигают в сторону контрастных чернил. У светлого
      // пузыря запаса на это нет: белым по нему 5.3:1, после сдвига — 4.47:1.
      // Значит, направление выбирается по запасу, а не по вкусу.
      const fill = nestedFill(p.bubbleOut);
      const ink = contrastingInk(p.bubbleOut);
      expect(contrast(ink, fill)).toBeGreaterThanOrEqual(4.5);
    });

    it.each([true, false])('пузырь опроса читается на своей поверхности (свой: %s)', (own) => {
      // До 391-го оба пузыря опроса (личный и групповой) красились одинаково
      // неверно: `isMe ? '#fff' : colors.text`, счётчики полупрозрачным белым,
      // верный ответ '#4caf50', свой неверный '#e53935'. На светлом пузыре
      // #0068D6 это 2.0:1 и 2.3:1 — после ответа на викторину не видно, угадал
      // ты или нет, то есть теряется единственное, ради чего строка нарисована.
      const ink = pollInk(p, own);
      const fill = own ? p.bubbleOut : p.surface;
      // Каждая роль проверяется НА СВОЕЙ подложке: половина знаков опроса лежит
      // не на пузыре, а на дорожке, и цвет, прошедший на пузыре, там порог уже
      // не держит.
      const onFill: [keyof PollInk, number][] = [
        ['text', 4.5], ['accent', 4.5], ['correct', 4.5], ['wrong', 4.5],
        // Отметка своего голоса — заливка, а не надпись: порог графики.
        ['accentFill', 3],
        // Счётчик — второстепенная подпись, порог общего `textMuted`: поднять
        // его здесь и только здесь значило бы сделать подписи опроса темнее
        // всех прочих подписей приложения.
        ['muted', 3],
      ];
      for (const [k, min] of onFill) {
        expect([own, k, contrast(ink[k], fill) >= min]).toEqual([own, k, true]);
      }
      // Дорожка видна на пузыре, но не за счёт того, что на ней написано.
      expect([own, contrast(ink.track, fill) >= 1.1]).toEqual([own, true]);
      const onTrack: [keyof PollInk, number][] = [
        // Плашка «Завершён» несёт надпись — порог текстовый.
        ['onTrack', 4.5],
        // Полосы — графика: различимы по длине, порог 3:1.
        ['bar', 3], ['barMine', 3], ['correctBar', 3], ['wrongBar', 3],
      ];
      for (const [k, min] of onTrack) {
        expect([own, k, contrast(ink[k], ink.track) >= min]).toEqual([own, k, true]);
      }
      // Галочка внутри залитой отметки читается на самой отметке.
      expect([own, contrast(ink.onAccent, ink.accentFill) >= 3]).toEqual([own, true]);
    });

    it('плашка реакции видна на том, на чём лежит', () => {
      // До 395-го плашка была залита 'rgba(61,90,254,0.18)', а счётчик прибит к
      // '#9aa3c0'. На СВОЁМ сообщении светлой темы пузырь и есть акцент
      // (#0068D6), поэтому подмешанный акцент давал к нему 1.01:1 — плашки не
      // было видно вовсе; счётчик там же давал 2.14:1, на чужом пузыре 1.67:1,
      // на фоне ленты 1.77:1 при пороге 4.5:1.
      for (const host of [p.bubbleOut, p.surface, p.surfaceHigh, p.background]) {
        const ink = reactionInk(p, host);
        expect([host, 'плашка', contrast(ink.fill, host) >= 1.15]).toEqual([host, 'плашка', true]);
        expect([host, 'счётчик', contrast(ink.count, ink.fill) >= 4.5]).toEqual([host, 'счётчик', true]);
        // Контур отделяет плашку от того, что снаружи, — порог графики к хозяину.
        expect([host, 'контур', contrast(ink.border, host) >= 3]).toEqual([host, 'контур', true]);
      }
    });

    it('надпись на плашке состояния читается на её же подложке', () => {
      // До 396-го подложка плашки была вписана в StyleSheet как '#1a3d2e' —
      // тёмно-зелёный прямоугольник в обеих темах, — а надпись бралась из
      // палитры: в светлой теме тёмно-зелёное по тёмно-зелёному, 1.94:1.
      const tones: BadgeTone[] = ['success', 'error', 'warning', 'accent', 'muted'];
      for (const tone of tones) {
        const { fill, ink } = badgeTint(p, tone);
        expect([tone, 'надпись', contrast(ink, fill) >= 4.5]).toEqual([tone, 'надпись', true]);
        // Подложку видно на карточке, иначе плашки нет как объекта.
        expect([tone, 'подложка', contrast(fill, p.surface) >= 1.05]).toEqual([tone, 'подложка', true]);
      }
    });

    it('состояния плашки не схлопываются в один цвет', () => {
      // «Вкл» и «Выкл» отличаются надписью, но плашка читается и боковым
      // зрением — цветом. Если тона сойдутся, останется только текст.
      const tones: BadgeTone[] = ['success', 'error', 'warning', 'accent', 'muted'];
      const fills = new Set(tones.map((t) => badgeTint(p, t).fill.toLowerCase()));
      expect(fills.size).toBe(tones.length);
    });

    it('значок меню виден на подложке своего же тона', () => {
      // До 392-го подложка бралась как `${цвет}22`, а значок — тем же цветом
      // as-is. На белой поверхности из тринадцати значков восемь не дотягивали
      // до 3:1 на собственной подложке: бирюзовый 2.04:1, оранжевый 1.94:1,
      // голубой 2.31:1, зелёный 2.45:1. В тёмной теме то же с фиолетовым.
      const hues: MenuIconHue[] = [...(Object.keys(MENU_ICON_HUES) as MenuIconHue[]), 'accent'];
      for (const hue of hues) {
        const { fill, ink } = tintedIcon(hue, p);
        expect([hue, 'значок', contrast(ink, fill) >= 3]).toEqual([hue, 'значок', true]);
        // Подложка при этом остаётся подложкой: её видно на карточке, но она
        // не спорит со значком.
        expect([hue, 'подложка', contrast(fill, p.surface) >= 1.05]).toEqual([hue, 'подложка', true]);
      }
    });

    it('значок меню виден при любом выбранном пользователем акценте', () => {
      // Первый пункт меню красится не литералом, а `primary`, то есть цветом
      // из настроек. Проверять только значение по умолчанию значит проверять
      // один вариант из десяти.
      for (const { hex, name } of ACCENT_SWATCHES) {
        const { fill, ink } = tintedIcon('accent', { ...p, primary: hex });
        expect([name, contrast(ink, fill) >= 3]).toEqual([name, true]);
      }
    });

    it('роли опроса, различающиеся только цветом, не схлопываются в один', () => {
      // Подъём до порога тянет цвета к чернилам, и на светлом пузыре запаса
      // мало: и «верно», и «неверно» уезжают в белёсое. Если они сойдутся в
      // одно значение, результат викторины будет читаться только по эмодзи, а
      // своя полоса от чужой не отличится вовсе.
      //
      // Различие по яркости тут требовать нельзя: зелёное против красного даёт
      // 1.02:1, синее против серого — столько же. Смысл этих пар несёт не
      // цвет — рядом стоят «✅ Правильно!» / «❌ Неверно», счётчик голосов и
      // жирность своего варианта. Тест сторожит ровно то, что можно: что цвета
      // остались разными.
      for (const own of [true, false]) {
        const ink = pollInk(p, own);
        const pairs: [keyof PollInk, keyof PollInk][] = [
          ['correct', 'wrong'], ['correctBar', 'wrongBar'], ['bar', 'barMine'],
        ];
        for (const [a, b] of pairs) {
          expect([own, a, b, ink[a].toLowerCase() === ink[b].toLowerCase()]).toEqual([own, a, b, false]);
        }
      }
    });

    it('чернила пузыря сохраняют тон исходного токена', () => {
      // Смысл правила — поднять свой же цвет до порога, а не подменить его
      // белым: иначе «прочитано», «не отправлено» и «в избранном» слились бы
      // в один цвет и статус читался бы только по форме значка.
      const ink = bubbleInk(p);
      const distinct = new Set([ink.accent, ink.error, ink.star].map((c) => c.toLowerCase()));
      expect(distinct.size).toBe(3);
    });

    it('в тёмной теме чернила пузыря — те же токены, что и на фоне', () => {
      // Тёмная заливка держит палитру сама, поэтому правка 386-го не должна
      // была ничего в ней сдвинуть: любой сдвиг здесь означал бы, что порог
      // подобран мимо и тёмную тему тянет за компанию со светлой.
      if (p !== darkColors) return;
      const ink = bubbleInk(p);
      expect(ink.accent.toLowerCase()).toBe(p.accent.toLowerCase());
      expect(ink.error.toLowerCase()).toBe(p.error.toLowerCase());
      expect(ink.star.toLowerCase()).toBe(p.star.toLowerCase());
      expect(ink.secondary.toLowerCase()).toBe(p.textSecondary.toLowerCase());
    });

    it.each(['errorFill', 'successFill', 'mutedFill'] as const)(
      '%s — заливка: белое поверх держит 4.5:1, сама она видна на фонах (3:1)',
      (token) => {
        // Два требования сразу, и они тянут в разные стороны: светлее — хуже
        // белому поверх, темнее — хуже самой плашке на тёмном фоне. Полоса
        // между ними узкая (яркость 0.154…0.183 в тёмной теме), и попасть в
        // неё на глаз нельзя — потому двадцать мест и стояли мимо.
        expect(contrast('#ffffff', p[token])).toBeGreaterThanOrEqual(4.5);
        for (const [surfaceName, bg] of surfacesOf(p)) {
          expect([surfaceName, contrast(p[token], bg) >= 3]).toEqual([surfaceName, true]);
        }
      }
    );

    it('заливка и надпись — разные роли, а не разные имена одного цвета', () => {
      // В светлой теме одно значение закрывает обе роли, и совпадение здесь
      // законно. В тёмной — нет: `error` там светло-розовый, белым по нему
      // 2.2:1. Проверяется не «различны», а то, что каждая роль держит СВОЙ
      // порог: иначе кто-нибудь сведёт их обратно в один токен.
      expect(contrast(p.error, p.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast('#ffffff', p.errorFill)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.success, p.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast('#ffffff', p.successFill)).toBeGreaterThanOrEqual(4.5);
    });

    it('звезда и предупреждение — разные цвета', () => {
      // Оба янтарные, и соблазн свести их в один токен велик: у «избранного»
      // и «внимание» пороги разные (3:1 против 4.5:1), и общий токен тянул бы
      // звезду в коричневый, а предупреждение — в нечитаемое.
      expect(p.star.toLowerCase()).not.toBe(p.warning.toLowerCase());
    });

    it.each(['neutral', 'ok', 'warn', 'error'] as const)(
      'полоска состояния «%s» читается на своей заливке (4.5:1)',
      (tone) => {
        // До 385-го у трёх полосок были свои тёмные заливки, вписанные руками:
        // в светлой теме они ложились тёмным пятном поверх белого фона.
        //
        // Заливка теперь — приподнятая поверхность палитры, а не оттенок
        // самого цвета: оттенок пробовался и опускал светлую тему до 3.7:1,
        // потому что её семантические цвета и так стоят у самого порога.
        const { ink, fill } = bannerColors(tone, p);
        expect(fill).toBe(p.surfaceHigh);
        expect([tone, contrast(ink, fill) >= 4.5]).toEqual([tone, true]);
      }
    );

    it('белый текст на заливке primary держит 4.5:1', () => {
      // primary — это фон кнопки, а не текст: проверяется надпись поверх неё.
      expect(contrast('#ffffff', p.primary)).toBeGreaterThanOrEqual(4.5);
    });

    it('primary как цвет текста держит хотя бы 3:1', () => {
      // Ссылками primary тоже пишут, но крупно и жирно — здесь порог для
      // крупного текста.
      expect(contrast(p.primary, p.background)).toBeGreaterThanOrEqual(3);
    });

    it('уровни серого различимы между собой', () => {
      // Иначе иерархия «основной → второстепенный → подпись» пропадает: три
      // почти одинаковых серых читаются как один.
      expect(contrast(p.text, p.textSecondary)).toBeGreaterThanOrEqual(1.5);
      expect(contrast(p.textSecondary, p.textMuted)).toBeGreaterThanOrEqual(1.2);
    });

    it('граница видна на фоне', () => {
      expect(contrast(p.border, p.background)).toBeGreaterThanOrEqual(1.2);
    });

    describe('исходящий пузырь', () => {
      it('его текст читается на нём (4.5:1)', () => {
        expect(contrast(p.bubbleOutText, p.bubbleOut)).toBeGreaterThanOrEqual(4.5);
      });

      it('служебный текст внутри пузыря тоже читается', () => {
        // Время, «изменено» и подпись перевода пишутся белым с прозрачностью
        // 0.7. На тёмной заливке результат совпадает со смешением с ней.
        const blend = mix('#ffffff', p.bubbleOut, 0.7);
        expect(contrast(blend, p.bubbleOut)).toBeGreaterThanOrEqual(3);
      });

      it('сам пузырь отделяется от фона чата', () => {
        // Иначе исходящее сообщение сливается с фоном и перестаёт читаться
        // как отдельный блок.
        expect(contrast(p.bubbleOut, p.background)).toBeGreaterThanOrEqual(1.2);
      });

      it('заливка тёмная в обеих темах — на ней светлый текст', () => {
        // Инвариант, на который опирается ChatScreen: цвета внутри пузыря
        // задаются признаком «на тёмной заливке», а не темой.
        expect(luminance(p.bubbleOut)).toBeLessThan(luminance(p.bubbleOutText));
        expect(contrast('#ffffff', p.bubbleOut)).toBeGreaterThanOrEqual(4.5);
      });
    });
  });

  it('светлая палитра не наследует цвета тёмной', () => {
    // Самая частая поломка светлой темы — токен, забытый копипастой из тёмной.
    for (const key of Object.keys(darkColors) as (keyof AppColors)[]) {
      expect(lightColors[key].toLowerCase()).not.toBe(darkColors[key].toLowerCase());
    }
  });

  it('набор токенов у палитр совпадает', () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(darkColors).sort());
  });

  it('все значения — семизначный hex, кроме названной волны нажатия', () => {
    // luminance() выше разбирает именно #RRGGBB; короткая или rgba-запись молча
    // дала бы NaN и все проверки прошли бы «успешно».
    //
    // v4.32.407: исключение ровно одно и названо здесь поимённо. `ripple`
    // прозрачен по делу — волна рисуется поверх уже проверенной поверхности на
    // доли секунды и не несёт ни надписи, ни значка. Всё остальное обязано
    // быть непрозрачным, иначе то, что увидит пользователь, зависит от того,
    // что окажется снизу, и посчитать это заранее нельзя.
    for (const [, p] of palettes) {
      for (const [token, value] of Object.entries(p)) {
        const shape = token === 'ripple' ? /^#[0-9a-fA-F]{8}$/ : /^#[0-9a-fA-F]{6}$/;
        expect({ token, ok: shape.test(value) }).toEqual({ token, ok: true });
      }
    }
  });

  it('resolveColors отдаёт запрошенную палитру', () => {
    expect(resolveColors('dark')).toBe(darkColors);
    expect(resolveColors('light')).toBe(lightColors);
  });

  describe('пользовательский акцент', () => {
    // accentColor из настроек подменяет primary целиком, а primary — заливка,
    // поверх которой в 99 местах написано белым. Это инвариант приложения, и
    // выбор пользователя не должен уметь его нарушить.
    it.each(ACCENT_SWATCHES.map((s) => [s.name, s.hex]))(
      'образец «%s» держит белую надпись (4.5:1)',
      (_name, hex) => {
        expect(contrast('#ffffff', hex)).toBeGreaterThanOrEqual(4.5);
      }
    );

    it('образцы проходят нормализацию без изменений', () => {
      // Иначе выбранный цвет и нарисованный расходились бы, и в пикере ничего
      // не выглядело бы выбранным.
      for (const { hex } of ACCENT_SWATCHES) {
        expect([hex, normalizeAccent(hex)]).toEqual([hex, hex]);
      }
    });

    it('образцы не повторяются', () => {
      const hexes = ACCENT_SWATCHES.map((s) => s.hex);
      expect(new Set(hexes).size).toBe(hexes.length);
    });

    it.each(['#00bcd4', '#4caf50', '#ff9800', '#f44336', '#e91e63', '#607d8b', '#ffffff'])(
      'нечитаемый %s приводится к 4.5:1',
      (hex) => {
        const safe = normalizeAccent(hex)!;
        expect([hex, contrast('#ffffff', safe) >= 4.5]).toEqual([hex, true]);
      }
    );

    it('нормализация сохраняет тон', () => {
      // Каналы умножаются на общий множитель, поэтому их порядок и отношения
      // сохраняются: оранжевый остаётся оранжевым, а не становится серым.
      for (const hex of ['#00bcd4', '#ff9800', '#4caf50']) {
        const before = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const after = [1, 3, 5].map((i) => parseInt(normalizeAccent(hex)!.slice(i, i + 2), 16));
        // Канал, который был наибольшим, остался наибольшим; нулевой — нулевым.
        expect(after.indexOf(Math.max(...after))).toBe(before.indexOf(Math.max(...before)));
        expect(after.map((v) => v === 0)).toEqual(before.map((v) => v === 0));
      }
    });

    it('нормализация идемпотентна', () => {
      for (const hex of ['#00bcd4', '#ff9800', '#3d5afe', '#000000']) {
        const once = normalizeAccent(hex)!;
        expect([hex, normalizeAccent(once)]).toEqual([hex, once]);
      }
    });

    // v4.32.348: один выбор пользователя разворачивается в два токена —
    // `primary` (заливка, normalizeAccent) и `accent` (текст, readableOn).
    describe.each(palettes)('на %s теме', (_name, p) => {
      it.each(ACCENT_SWATCHES.map((s) => [s.name, s.hex]))(
        'образец «%s» как текст доводится до 4.5:1 на фоне',
        (_swatchName, hex) => {
          expect(contrast(readableOn(hex, p.background)!, p.background)).toBeGreaterThanOrEqual(4.5);
        }
      );

      it('оба производных токена получаются из одного выбора и оба читаемы', () => {
        for (const { hex } of ACCENT_SWATCHES) {
          const fill = normalizeAccent(hex)!;
          const ink = readableOn(hex, p.background)!;
          expect([hex, contrast('#ffffff', fill) >= 4.5]).toEqual([hex, true]);
          expect([hex, contrast(ink, p.background) >= 4.5]).toEqual([hex, true]);
        }
      });

      it('уже читаемый цвет не трогается', () => {
        // Сравнение без учёта регистра: функция всегда отдаёт нижний, а в
        // светлой палитре значения записаны верхним. Цвет тот же самый.
        expect(readableOn(p.accent, p.background)).toBe(p.accent.toLowerCase());
      });

      it('readableOn идемпотентна', () => {
        for (const { hex } of ACCENT_SWATCHES) {
          const once = readableOn(hex, p.background)!;
          expect([hex, readableOn(once, p.background)]).toEqual([hex, once]);
        }
      });
    });

    it('readableOn сохраняет тон', () => {
      // На тёмном фоне цвет подмешивается к белому, на светлом — темнеет; в
      // обоих случаях порядок каналов сохраняется, иначе оранжевый превратился
      // бы в серый или в другой цвет.
      for (const bg of [darkColors.background, lightColors.background]) {
        for (const hex of ['#a86400', '#008191', '#e11d60']) {
          const before = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
          const after = [1, 3, 5].map((i) => parseInt(readableOn(hex, bg)!.slice(i, i + 2), 16));
          expect([hex, bg, after.indexOf(Math.max(...after))])
            .toEqual([hex, bg, before.indexOf(Math.max(...before))]);
        }
      }
    });

    it('readableOn отбрасывает мусор в обоих аргументах', () => {
      expect(readableOn('nope', darkColors.background)).toBeNull();
      expect(readableOn('#a86400', 'nope')).toBeNull();
    });

    it('мусор из хранилища отбрасывается, а не красит интерфейс', () => {
      // В app_accent_color с прошлых версий могло остаться что угодно, вплоть
      // до пустой строки. null означает «акцента нет», то есть палитра как есть.
      for (const bad of ['', 'red', '#fff', '#12345', '#gggggg', 'rgba(0,0,0,1)']) {
        expect([bad, normalizeAccent(bad)]).toEqual([bad, null]);
      }
    });
  });

  describe('contrastingInk', () => {
    // Ровно те образцы, что предлагаются в настройках как «цвет акцента»,
    // плюс primary обеих палитр — заливка образца «по умолчанию».
    const swatches = [...ACCENT_SWATCHES.map((s) => s.hex), darkColors.primary, lightColors.primary];

    it.each(swatches)('на %s даёт контраст не ниже 3:1', (swatch) => {
      expect([swatch, contrast(contrastingInk(swatch), swatch) >= 3]).toEqual([swatch, true]);
    });

    it('всегда выбирает лучший из двух вариантов', () => {
      for (const swatch of swatches) {
        const ink = contrastingInk(swatch);
        const other = ink === '#ffffff' ? '#000000' : '#ffffff';
        expect([swatch, contrast(ink, swatch) >= contrast(other, swatch)]).toEqual([swatch, true]);
      }
    });

    it('на крайних значениях ведёт себя очевидно', () => {
      expect(contrastingInk('#ffffff')).toBe('#000000');
      expect(contrastingInk('#000000')).toBe('#ffffff');
    });
  });

  // v4.32.352: третья роль одного и того же выбора. `primary` — заливка,
  // `accent` — текст НА ФОНЕ СТРАНИЦЫ, и ровно поэтому accent нельзя писать
  // внутри пузыря: там под ним не фон, а заливка. Замеры до правки:
  // ссылка в своём сообщении на светлой теме 1.11:1, упоминание в группе на
  // тёмной 2.90:1, «@все» цветом error на синей заливке 1.21:1.
  describe('accentOnFill', () => {
    it('акцент с фона страницы на заливке своего пузыря нечитаем', () => {
      // Причина раунда, зафиксированная цифрами. Заливка своего пузыря в
      // группе — primary в обеих темах: 2.90:1 и 1.11:1. В личных чатах
      // заливка своя: тёмная #1a2e5e держит accent сама (7.4:1) — там правка
      // ничего не меняет, а вот светлая #0068D6 совпадает с primary и даёт те
      // же 1.11:1. Если палитру однажды подвинут и проверка упадёт — значит
      // accentOnFill стал не нужен, а не сломался.
      expect(contrast(darkColors.accent, darkColors.primary)).toBeLessThan(4.5);
      expect(contrast(lightColors.accent, lightColors.primary)).toBeLessThan(4.5);
      expect(contrast(lightColors.accent, lightColors.bubbleOut)).toBeLessThan(4.5);
      expect(contrast(darkColors.accent, darkColors.bubbleOut)).toBeGreaterThanOrEqual(4.5);
    });

    describe.each(palettes)('%s тема', (_name, p) => {
      it('ссылка в исходящем пузыре чата доводится до 4.5:1', () => {
        const ink = accentOnFill(p.accent, p.bubbleOut, p.bubbleOutText);
        expect(contrast(ink, p.bubbleOut)).toBeGreaterThanOrEqual(4.5);
      });

      it('ссылка и упоминание в своём пузыре группы доводятся до 4.5:1', () => {
        // В группах заливка своего пузыря — primary, а не bubbleOut.
        for (const token of [p.accent, p.error]) {
          const ink = accentOnFill(token, p.primary, '#ffffff');
          expect([token, contrast(ink, p.primary) >= 4.5]).toEqual([token, true]);
        }
      });

      it('держится и на пользовательском акценте, а не только на палитре', () => {
        // Заливка своего пузыря в группе — normalizeAccent(выбор), а надпись
        // на ней считается от неё же. Оба конца двигаются вместе.
        for (const { hex } of ACCENT_SWATCHES) {
          const fill = normalizeAccent(hex)!;
          const ink = accentOnFill(readableOn(hex, p.background)!, fill, '#ffffff');
          expect([hex, contrast(ink, fill) >= 4.5]).toEqual([hex, true]);
        }
      });
    });

    it('сохраняет тон: ссылка остаётся «той же синей», просто светлее', () => {
      const fill = lightColors.primary;
      for (const hex of ['#036b96', '#a86400', '#e11d60']) {
        const before = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const after = [1, 3, 5].map((i) => parseInt(accentOnFill(hex, fill, '#ffffff').slice(i, i + 2), 16));
        expect([hex, after.indexOf(Math.max(...after))])
          .toEqual([hex, before.indexOf(Math.max(...before))]);
      }
    });

    it('на нераспознанном цвете отдаёт fallback, а не нечитаемую строку', () => {
      // Из пользовательской темы сюда может прийти rgba(...) — тогда лучше
      // заведомо контрастный цвет содержимого пузыря, чем «как было».
      for (const bad of ['rgba(0,0,0,1)', '#fff', '']) {
        expect([bad, accentOnFill(bad, darkColors.primary, '#ffffff')]).toEqual([bad, '#ffffff']);
      }
      expect(accentOnFill(darkColors.accent, 'nope', '#ffffff')).toBe('#ffffff');
    });

    it('идемпотентна: повторный пересчёт ничего не двигает', () => {
      for (const [, p] of palettes) {
        const once = accentOnFill(p.accent, p.bubbleOut, p.bubbleOutText);
        expect(accentOnFill(once, p.bubbleOut, p.bubbleOutText)).toBe(once);
      }
    });
  });

  describe('разрешение схемы', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('явный режим не спрашивает систему', () => {
      const spy = jest.spyOn(Appearance, 'getColorScheme');
      expect(resolveScheme('dark')).toBe('dark');
      expect(resolveScheme('light')).toBe('light');
      expect(spy).not.toHaveBeenCalled();
    });

    it("'system' следует за системой", () => {
      jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('light');
      expect(resolveScheme('system')).toBe('light');
      jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('dark');
      expect(resolveScheme('system')).toBe('dark');
    });

    // На iOS getColorScheme() возвращает null, пока приложение не отрисовало
    // первый кадр. Тёмная — тема приложения по умолчанию, и в неё же уходит
    // ветка «система молчит».
    it("'system' без ответа системы даёт тёмную", () => {
      jest.spyOn(Appearance, 'getColorScheme').mockReturnValue(null);
      expect(resolveScheme('system')).toBe('dark');
    });

    it('colorsForScheme и resolveColors согласованы', () => {
      expect(colorsForScheme('dark')).toBe(darkColors);
      expect(colorsForScheme('light')).toBe(lightColors);
      jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('light');
      expect(resolveColors('system')).toBe(colorsForScheme(resolveScheme('system')));
    });
  });

  describe('кружок-различитель', () => {
    it('даёт #RRGGBB на всём круге тонов', () => {
      for (let hue = 0; hue < 360; hue += 5) {
        expect([hue, /^#[0-9a-f]{6}$/.test(identityFill(hue))]).toEqual([hue, true]);
      }
      // Отрицательный и «больше круга» приводятся к тому же тону: хеш ключа
      // никакого диапазона не обещает.
      expect(identityFill(-360)).toBe(identityFill(0));
      expect(identityFill(725)).toBe(identityFill(5));
    });

    it('буква читается на кружке при любом тоне', () => {
      // Раньше цвет был строкой 'hsl(…)': contrastingInk её не разбирает, и
      // буква писалась белой руками — верно, но недоказуемо.
      for (let hue = 0; hue < 360; hue += 5) {
        const bg = identityFill(hue);
        expect([hue, contrast(contrastingInk(bg), bg) >= 4.5]).toEqual([hue, true]);
      }
      // То же самое, но через API, которым пользуются экраны.
      for (const seed of ['A', 'Александр', 'Анна', 'MCowBQYDK2VwAyEA', '']) {
        const { fill, ink } = identityAvatar(seed);
        expect([seed, contrast(ink, fill) >= 4.5]).toEqual([seed, true]);
      }
    });

    it('тон держится за строку целиком, а не за первую букву', () => {
      // Прежний вывод — seed.charCodeAt(0) * 31 — смотрел на ОДИН символ:
      // «Александр» и «Анна» получали ровно один цвет, а различитель ничего не
      // различал.
      expect(identityHue('Александр')).not.toBe(identityHue('Анна'));
      expect(identityHue('Анна')).toBe(identityHue('Анна'));
      // Ключ длинный и отличается в середине — прежнее правило видело бы один
      // и тот же первый символ у всех.
      expect(identityHue('MCowBQYDK2VwAyEAaaaa')).not.toBe(identityHue('MCowBQYDK2VwAyEAbbbb'));
    });

    it('имя, окрашенное различителем, читается на своей поверхности', () => {
      // Было hsl(тон, 58%, 36%) в светлой теме на все тона разом: на
      // жёлто-зелёном это 3.34:1 на белом пузыре при пороге 4.5:1 — имя части
      // участников там не читалось, и кого именно, зависело от их имени.
      for (const [, p] of palettes) {
        for (let hue = 0; hue < 360; hue += 5) {
          const seed = `seed-${hue}`;
          for (const host of [p.surface, p.surfaceHigh, p.background]) {
            expect([host, seed, contrast(identityInk(seed, host), host) >= 4.5]).toEqual([host, seed, true]);
          }
        }
      }
    });
  });
});

describe('переключатель', () => {
  // v4.32.400. Дорожку красили токеном ВОЛОСЯНОЙ ЛИНИИ (`border`), а бегунок
  // писали '#fff'. В светлой теме это давало 1.52:1 и к карточке, и к
  // бегунку: выключенный переключатель пропадал с экрана целиком.
  describe.each(palettes)('%s', (_name, p) => {
    it('выключенная дорожка видна на любой из поверхностей', () => {
      const tone = switchTone(p);
      for (const host of [p.surface, p.surfaceHigh, p.background]) {
        expect([host, contrast(tone.trackOff, host) >= 3]).toEqual([host, true]);
      }
    });

    it('бегунок виден на дорожке в обоих состояниях', () => {
      const tone = switchTone(p);
      expect(contrast(tone.thumb, tone.trackOff) >= 3).toBe(true);
      expect(contrast(tone.thumb, tone.trackOn) >= 3).toBe(true);
    });

    it('состояния различимы, и различимы не одним лишь цветом', () => {
      const tone = switchTone(p);
      // Дорожки обязаны отличаться — одинаковые означали бы, что состояние
      // не показано вовсе.
      expect(tone.trackOff).not.toBe(tone.trackOn);
      // Но по ЯРКОСТИ они близки (серый и синий одной светлоты дают ~1.1:1),
      // поэтому в монохромном зрении цвет состояние не передаёт. Передаёт его
      // положение бегунка — а бегунок обязан быть виден в обоих состояниях,
      // что и проверено выше. Это WCAG 1.4.1: цвет не может быть единственным
      // признаком, и здесь он единственным не является.
      expect(contrast(tone.thumb, tone.trackOff) >= 3).toBe(true);
      expect(contrast(tone.thumb, tone.trackOn) >= 3).toBe(true);
    });

    it('бегунок держится на дорожке при ЛЮБОМ выбранном акценте', () => {
      // Включённая дорожка — это акцент, и его выбирает пользователь.
      // Видимость в этом состоянии несёт бегунок, поэтому проверяется он.
      for (const swatch of ACCENT_SWATCHES) {
        const primary = normalizeAccent(swatch.hex);
        expect([swatch.hex, primary !== null]).toEqual([swatch.hex, true]);
        const tone = switchTone({ ...p, primary: primary as string });
        expect([swatch.hex, contrast(tone.thumb, tone.trackOn) >= 3]).toEqual([swatch.hex, true]);
        expect([swatch.hex, contrast(tone.thumb, tone.trackOff) >= 3]).toEqual([swatch.hex, true]);
      }
    });
  });
});

describe('подсветка строки', () => {
  it('плёнка собирается из hex палитры', () => {
    expect(withAlpha('#3d5afe', 0.13)).toBe('rgba(61, 90, 254, 0.13)');
    expect(withAlpha('#FFFFFF', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  it('прозрачность зажата в [0,1] — анимация не уводит её за край', () => {
    expect(withAlpha('#3d5afe', -1)).toBe('rgba(61, 90, 254, 0)');
    expect(withAlpha('#3d5afe', 7)).toBe('rgba(61, 90, 254, 1)');
  });

  it('неразбираемый цвет даёт прозрачность, а не цвет наугад', () => {
    // В пользовательской теме на месте токена может оказаться готовая
    // rgba-строка. Прежний вывод — `colors.primary + '22'` — приклеивал к ней
    // два символа и получал строку, которую RN не разбирает вовсе.
    expect(withAlpha('rgba(1,2,3,0.5)', 0.5)).toBe('transparent');
    expect(withAlpha('#abc', 0.5)).toBe('transparent');
  });

  describe.each(palettes)('%s', (_name, p) => {
    it('«выбрано» и «найдено» — разные плёнки', () => {
      expect(rowMark(p, 'selected')).not.toBe(rowMark(p, 'found'));
    });

    it('вспышка перехода начинается с полной прозрачности', () => {
      expect(rowMark(p, 'found', 0)).toBe(withAlpha(p.star, 0));
      expect(rowMark(p, 'found', 0.35)).toBe(withAlpha(p.star, 0.35));
    });

    it('плёнка выведена из токенов, а не вписана', () => {
      expect(rowMark(p, 'selected')).toBe(withAlpha(p.primary, 0.13));
      expect(rowMark(p, 'found')).toBe(withAlpha(p.star, 0.13));
    });
  });
});

describe('вложенная карточка в пузыре', () => {
  describe.each(palettes)('%s', (_name, p) => {
    it('предпросмотр ссылки читается в пузыре любой стороны', () => {
      // v4.32.401: содержимое карточки было белым с прозрачностью, то есть
      // считалось от белого. В светлой теме исходящий пузырь сам светло-синий,
      // и «белое 60%» на нём давало 1.9:1.
      for (const host of [p.bubbleOut, p.surfaceHigh]) {
        const fill = nestedFill(host);
        const ink = inkOn(p, fill);
        expect([host, contrast(ink.text, fill) >= 4.5]).toEqual([host, true]);
        expect([host, contrast(ink.secondary, fill) >= 4.5]).toEqual([host, true]);
        expect([host, contrast(ink.accent, fill) >= 3]).toEqual([host, true]);
        expect([host, contrast(ink.muted, fill) >= 3]).toEqual([host, true]);
        // Карточка обязана отличаться от пузыря, в котором лежит: до 401-го
        // входящая карточка красилась ровно цветом входящего пузыря.
        expect([host, contrast(fill, host) > 1.1]).toEqual([host, true]);
      }
    });

    it('полоса живой геолокации читается', () => {
      const ink = inkOn(p, p.successFill);
      expect(contrast(ink.text, p.successFill) >= 4.5).toBe(true);
      expect(contrast(ink.secondary, p.successFill) >= 4.5).toBe(true);
      expect(contrast(ink.success, p.successFill) >= 3).toBe(true);
    });
  });
});

describe('чернила на цвете-данных', () => {
  // v4.32.402. Метку переписки и цвет папки выбирает пользователь из семи
  // пресетов, среди которых жёлтый и зелёный. Галочка выбранной метки, кольцо
  // вокруг неё и счётчик на вкладке папки были написаны '#fff': на жёлтом это
  // 1.87:1 — цифры на вкладке не было видно вовсе.
  //
  // Проверяется не список пресетов (он ДАННЫЕ и может смениться), а свойство
  // самой функции: любой цвет обязан получить читаемые чернила.
  it('на любом цвете чернила берут порог обычного текста', () => {
    const bad: string[] = [];
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
          if (contrast(contrastingInk(hex), hex) < 4.5) bad.push(hex);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('на жёлтой метке чернила чёрные, а белые там не проходили', () => {
    expect(contrastingInk('#f1c40f')).toBe('#000000');
    expect(contrast('#ffffff', '#f1c40f') < 3).toBe(true);
  });
});

describe('список чатов', () => {
  describe.each(palettes)('%s', (_name, p) => {
    it('счётчик непрочитанного читается на обеих своих заливках', () => {
      // Заливок у него две — акцент и «приглушено», а цифра была одна и белая.
      for (const fill of [p.primary, p.mutedFill]) {
        expect([fill, contrast(contrastingInk(fill), fill) >= 4.5]).toEqual([fill, true]);
      }
    });

    it('полоса «нет соединения» читается', () => {
      const ink = inkOn(p, p.mutedFill);
      expect(contrast(ink.text, p.mutedFill) >= 4.5).toBe(true);
      expect(contrast(ink.secondary, p.mutedFill) >= 4.5).toBe(true);
      // И сама полоса обязана отличаться от того, что под ней.
      expect(contrast(p.mutedFill, p.background) >= 3).toBe(true);
    });

    it('отключённая кнопка рассылки — заливка, а не волосяная линия', () => {
      // Та же подмена, что у дорожки переключателя в 400-м: `border` — токен
      // линии в один пиксель, и как заливка кружка он давал 1.52:1.
      expect(contrast(p.mutedFill, p.surface) >= 3).toBe(true);
      expect(contrast(contrastingInk(p.mutedFill), p.mutedFill) >= 4.5).toBe(true);
    });

    it('галочка на плитке свайпа видна при любом выбранном акценте', () => {
      for (const swatch of ACCENT_SWATCHES) {
        const primary = normalizeAccent(swatch.hex);
        expect([swatch.hex, primary !== null]).toEqual([swatch.hex, true]);
        const fill = primary as string;
        expect([swatch.hex, contrast(contrastingInk(fill), fill) >= 4.5]).toEqual([swatch.hex, true]);
      }
    });
  });
});

describe('слой поверх кадра', () => {
  // v4.32.403. Сканер QR, просмотрщик медиа, предпросмотр вложения, лист
  // вложений и окно звонка писали этот слой тридцатью литералами '#000' и
  // '#fff'. Значения были верны, способ — нет: одно правило в тридцати
  // копиях нельзя проверить, и среди тех копий пряталась треть таких, где
  // литерал стоял по ошибке — на акцентной кнопке, на тексте ошибки.
  it('чернила читаются на подложке слоя', () => {
    expect(contrast(mediaScrim.ink, mediaScrim.fill) >= 4.5).toBe(true);
    expect(contrast(mediaScrim.inkMuted, mediaScrim.fill) >= 4.5).toBe(true);
    expect(contrast(mediaScrim.error, mediaScrim.fill) >= 4.5).toBe(true);
  });

  it('панель поверх кадра считается от ХУДШЕГО кадра — белого', () => {
    // Кадр неизвестен, но ограничен: светлее белого он не бывает. Панель —
    // чёрное с прозрачностью, поэтому самый светлый её результат выходит
    // именно над белым. На нём и обязана держаться гарантия.
    const worst = mix(mediaScrim.fill, '#ffffff', mediaScrim.barAlpha);
    expect(contrast(mediaScrim.ink, worst) >= 4.5).toBe(true);
    expect(contrast(mediaScrim.inkMuted, worst) >= 3).toBe(true);
  });

  it('прежняя прозрачность 0.45 порога не брала', () => {
    // Проверка выше — не тавтология: до 403-го верхний ряд просмотрщика был
    // 0.45, и счётчик «3 / 12» над светлой фотографией давал 3.36:1.
    const weak = mix(mediaScrim.fill, '#ffffff', 0.45);
    expect(contrast(mediaScrim.ink, weak) < 4.5).toBe(true);
  });

  it('слой не зависит от темы — он и не должен', () => {
    // Под ним не поверхность страницы, а кадр. Если однажды кто-то выведет
    // эти значения из палитры, тест упадёт и напомнит, почему так нельзя.
    for (const [, p] of palettes) {
      expect(mediaScrim.fill).not.toBe(p.background);
      expect(mediaScrim.fill).not.toBe(p.surface);
    }
  });
});

describe('отметки поверх миниатюры', () => {
  // v4.32.404. Кружок выбора в листе вложений лежит на МИНИАТЮРЕ, и плёнка
  // под ним была 0.3. Поверх светлой фотографии белое кольцо давало 2.12:1 —
  // по снимку было не понять, отмечен он или нет.
  it('плёнка под кружком выбора держит кольцо над любым кадром', () => {
    const worst = mix(mediaScrim.fill, '#ffffff', mediaScrim.barAlpha);
    expect(contrast(mediaScrim.ink, worst) >= 3).toBe(true);
  });

  it('прежние 0.3 порога не брали', () => {
    const weak = mix(mediaScrim.fill, '#ffffff', 0.3);
    expect(contrast(mediaScrim.ink, weak) < 3).toBe(true);
  });

  describe.each(palettes)('%s', (_name, p) => {
    it('приглушённый акцент — заливка, и подпись на нём считается от него', () => {
      // v4.32.404: у отключённой кнопки отправки подпись была написана
      // '#fff' при заливке primaryMuted. В светлой теме это #E1F0FF —
      // 1.13:1, то есть подписи не было бы вовсе. Стиль оказался мёртвым
      // (панель рисуется только при непустом выборе) и удалён, но правило
      // остаётся: на этой заливке чернила выводятся, а не назначаются.
      const fill = p.primaryMuted ?? p.surfaceHigh;
      expect(contrast(contrastingInk(fill), fill) >= 4.5).toBe(true);
    });
  });

  it('в светлой теме белое на приглушённом акценте не проходит', () => {
    expect(contrast('#ffffff', lightColors.primaryMuted ?? lightColors.surfaceHigh) < 3).toBe(true);
  });
});

describe('экран звонка', () => {
  // v4.32.405. Экран звонка тёмный при любой теме (388), но «тёмный» до сих
  // пор означало два литерала: '#111' и '#1a6b3c'. Второй и оказался дырой.
  const phases: CallPhase[] = ['active', 'ended'];

  describe.each(phases)('%s', (phase) => {
    const tone = callTone(phase);

    it('круглые кнопки видны на фоне звонка', () => {
      // Это ЗАЛИВКИ, а не надписи, поэтому порог графики 3:1 (WCAG 1.4.11).
      expect(contrast(tone.accept, tone.fill) >= 3).toBe(true);
      expect(contrast(tone.hangup, tone.fill) >= 3).toBe(true);
    });

    it('значки внутри круглых кнопок выводятся из заливки', () => {
      expect(contrast(tone.acceptInk, tone.accept) >= 4.5).toBe(true);
      expect(contrast(tone.hangupInk, tone.hangup) >= 4.5).toBe(true);
    });

    it('имя и состояние читаются на фоне', () => {
      expect(contrast(tone.ink, tone.fill) >= 4.5).toBe(true);
      expect(contrast(tone.inkMuted, tone.fill) >= 4.5).toBe(true);
    });

    it('инициалы читаются в своём кружке', () => {
      expect(contrast(tone.avatarInk, tone.avatarFill) >= 4.5).toBe(true);
    });

    it('подписи кнопок читаются в обоих состояниях кнопки', () => {
      // Кнопки «микрофон» и «динамик» меняют заливку при нажатии, и подпись
      // лежит ВНУТРИ них: считать надо от обеих заливок, а не от фона.
      expect(contrast(tone.ink, tone.chip) >= 4.5).toBe(true);
      expect(contrast(tone.ink, tone.chipActive) >= 4.5).toBe(true);
    });

    it('кольца входящего вызова видны на фоне', () => {
      expect(contrast(tone.ring, tone.fill) >= 3).toBe(true);
    });
  });

  it('фон идущего звонка отличается от завершённого', () => {
    // Зелёный оттенок — единственное, что отличает «звонок идёт» от
    // «звонок закончился» на самом фоне, поэтому он должен остаться.
    expect(callTone('active').fill).not.toBe(callTone('ended').fill);
  });

  it('прежний зелёный фон прятал обе круглые кнопки', () => {
    // Не тавтология: '#1a6b3c' стоял в коде до 405-го и давал 1.38:1 —
    // кнопки отличались от фона почти только цветом.
    expect(contrast(darkColors.successFill, '#1a6b3c') < 3).toBe(true);
    expect(contrast(darkColors.errorFill, '#1a6b3c') < 3).toBe(true);
  });

  it('«принять» и «отклонить» неразличимы по яркости', () => {
    // 1.00:1. Значит в монохромном зрении заливка не различает эти кнопки
    // вовсе, и их различают только повёрнутый значок и подписи
    // «Принять» / «Отклонить» в CallOverlay. Убирать их нельзя — это
    // требование WCAG 1.4.1, а не оформление.
    expect(contrast(darkColors.successFill, darkColors.errorFill) < 1.1).toBe(true);
  });

  it('экран звонка не зависит от темы', () => {
    // Оверлей занимает весь экран и появляется поверх чего угодно, поэтому
    // он тёмный и в светлой теме: цвета берутся из тёмной палитры напрямую.
    expect(callTone('ended').fill).toBe(darkColors.background);
    expect(callTone('ended').fill).not.toBe(lightColors.background);
  });
});

describe('лента', () => {
  // v4.32.406. Плашка очереди: подложка янтарная, и надпись на ней тоже была
  // янтарной — '#ffb020'. Значок рядом при этом брался из палитры, то есть
  // одно правило стояло в двух экземплярах и один разошёлся с другим.
  describe.each(palettes)('%s', (_name, p) => {
    it('надпись очереди читается на своей подложке', () => {
      // Плашка стоит на фоне экрана — от него и считается подложка, а надпись
      // и подсказка считаются от подложки, а не от фона.
      const q = badgeTint(p, 'warning', p.background);
      expect(contrast(q.ink, q.fill) >= 4.5).toBe(true);
      expect(contrast(inkOn(p, q.fill).secondary, q.fill) >= 4.5).toBe(true);
    });

    it('лист реакций — приподнятая поверхность, а не свой тёмный цвет', () => {
      // Тот же дефект, что в 396-м у непрочитанного поста.
      expect(contrast(p.text, p.surfaceHigh) >= 4.5).toBe(true);
      expect(contrast(p.text, nestedFill(p.surfaceHigh)) >= 4.5).toBe(true);
    });
  });

  it('прежний янтарь по янтарю в светлой теме не читался', () => {
    // Не тавтология: '#ffb020' стоял в коде до 406-го.
    const wash = mix('#ff9500', lightColors.background, 0.12);
    expect(contrast('#ffb020', wash) < 3).toBe(true);
  });

  it('прежний тёмно-синий лист реакций в светлой теме был пустым', () => {
    // 1.10:1 — заголовка «Реакция» на нём попросту не было видно.
    expect(contrast(lightColors.text, '#1a2340') < 1.5).toBe(true);
  });

  it('прежняя магента канала не держала белый значок', () => {
    // '#e91e8c' с белым значком давала 4.18:1, и белые чернила на ней —
    // не тот выбор, который делает само правило.
    expect(contrast('#ffffff', '#e91e8c') < 4.5).toBe(true);
    expect(contrastingInk('#e91e8c')).toBe('#000000');
  });
});

describe('приглушённая заливка и волна нажатия', () => {
  // v4.32.407. Стоило выбрать ЛЮБОЙ акцент, и `primaryMuted` переставал быть
  // непрозрачным: он собирался как `accent + '33'`. Дефект тихий вдвойне.
  // Во-первых, восьмизначный цвет не разбирается: contrastRatio отдаёт 1, а
  // contrastingInk молча отвечает белым — то есть проверка не падала, она
  // просто переставала быть проверкой. Во-вторых, то, что нарисовано на
  // экране, зависело от того, что окажется под подложкой.
  const accents = ACCENT_SWATCHES.map((sw) => sw.hex);

  it('восьмизначный цвет не считается — и не должен считаться проходящим', () => {
    expect(contrastRatio('#000000', '#3d5afe33')).toBe(1);
    expect(contrastingInk('#00bcd433')).toBe('#ffffff');
    expect(contrastingInk('#00bcd4')).toBe('#000000');
  });

  describe.each(palettes)('%s', (_name, p) => {
    it.each(accents)('выбранный акцент %s не делает токены прозрачными', (hex) => {
      const c = applyAccent(p, hex);
      for (const [key, value] of Object.entries(c)) {
        if (typeof value !== 'string' || !value.startsWith('#')) continue;
        if (key === 'ripple') continue;
        expect([key, /^#[0-9a-fA-F]{6}$/.test(value)]).toEqual([key, true]);
      }
    });

    it.each(accents)('надпись на приглушённой заливке читается при акценте %s', (hex) => {
      const c = applyAccent(p, hex);
      // Два способа получить чернила, оба используются в приложении: с
      // сохранением тона акцента и обычные текстовые.
      expect(contrast(readableInk(c.accent, c.primaryMuted, 4.5), c.primaryMuted) >= 4.5).toBe(true);
      expect(contrast(inkOn(c, c.primaryMuted).text, c.primaryMuted) >= 4.5).toBe(true);
    });

    it.each(accents)('прежняя подложка акцента %s не держала надпись', (hex) => {
      // Не тавтология: так это и было нарисовано до 407-го — подложка
      // проступала сквозь себя на фон страницы, а писали на ней `accent`.
      const c = applyAccent(p, hex);
      const oldFill = mix(hex, p.background, 0x33 / 255);
      expect(contrast(c.accent, oldFill) < 4.5).toBe(true);
    });
  });
});

describe('лента: плашки «включено»', () => {
  // v4.32.408. Одно правило, восемнадцать копий, и все восемнадцать делали
  // одно и то же неверно: подложка активного состояния подмешивалась
  // прозрачностью прямо на месте вызова (`colors.primary + '22'`), а надпись
  // на ней бралась из палитры, где она проверена на ФОНЕ, а не на подложке.

  describe.each(palettes)('%s', (_name, p) => {
    it('надпись на плашке активного режима читается', () => {
      const active = badgeTint(p, 'accent', p.background);
      expect(contrast(active.ink, active.fill) >= 4.5).toBe(true);
    });

    it('надпись, под которой плашка лишь появляется, читается и с ней, и без неё', () => {
      // Подписи кнопок форматирования остаются на месте, когда под ними
      // возникает плашка нажатия: цвет обязан держать оба состояния.
      const active = badgeTint(p, 'accent', p.background);
      const ink = inkOn(p, active.fill).secondary;
      expect(contrast(ink, active.fill) >= 4.5).toBe(true);
      expect(contrast(ink, p.background) >= 4.5).toBe(true);
    });

    it('приглушённая плашка читается', () => {
      const quiet = badgeTint(p, 'muted', p.background);
      expect(contrast(quiet.ink, quiet.fill) >= 4.5).toBe(true);
    });

    it('пилюля реакции на карточке комментария читается', () => {
      const pill = badgeTint(p, 'accent', p.surface);
      expect(contrast(pill.ink, pill.fill) >= 4.5).toBe(true);
    });

    it('опрос: надпись варианта читается и на полосе результата, и без неё', () => {
      const bubble = badgeTint(p, 'accent', p.surface);
      const bar = nestedFill(bubble.fill);
      const barInk = inkOn(p, bar);
      expect(contrast(barInk.text, bar) >= 4.5).toBe(true);
      expect(contrast(barInk.text, bubble.fill) >= 4.5).toBe(true);
      expect(contrast(readableInk(p.accent, bar, 4.5), bar) >= 4.5).toBe(true);
      expect(contrast(inkOn(p, bubble.fill).secondary, bubble.fill) >= 4.5).toBe(true);
      // Полоса обязана быть отличима от подложки пузыря. Порог здесь низкий и
      // это осознанно: доля голосов напечатана рядом ЧИСЛОМ, полоса её только
      // подкрепляет, а не несёт одна (1.4.1). Требовать от неё 3:1 значило бы
      // залить пол-опроса плотным цветом ради второго экземпляра той же цифры.
      expect(contrast(bar, bubble.fill) >= 1.2).toBe(true);
      // Рамка пузыря отделяет его от карточки поста.
      expect(contrast(p.accent, p.surface) >= 3).toBe(true);
    });

    it('прежние плашки надпись не держали', () => {
      // Не тавтологии: ровно те значения, что рисовались до 408-го.
      expect(contrast(p.textMuted, mix(p.border, p.background, 0xaa / 255)) < 4.5).toBe(true);
      // И главное — посчитать их было нельзя вовсе: восьмизначный цвет
      // возвращает 1, то есть проверка молчала бы при любом акценте.
      expect(contrastRatio(p.accent, p.primary + '22')).toBe(1);
    });
  });

  it('в светлой теме акцент на прежней плашке не дотягивал', () => {
    // v4.32.529: значения приколочены, а не взяты из палитры. Это свидетель:
    // он показывает, ЧТО рисовалось до 408-го и почему плашке понадобился
    // сплошной токен. Читать сюда живую палитру — значит утверждать, будто
    // сегодняшняя тоже не дотягивает; после ухода бренда с индиго
    // (#0068D6 → #00697F) это стало неправдой, и тест упал на собственной
    // посылке, а не на регрессе. Свидетель обязан называть свои цвета.
    const WAS_ACCENT = '#036B96';
    const WAS_PRIMARY = '#0068D6';
    const bg = lightColors.background;
    expect(contrast(WAS_ACCENT, mix(WAS_PRIMARY, bg, 0x22 / 255))).toBeLessThan(4.5);
    expect(contrast(WAS_ACCENT, mix(WAS_PRIMARY, bg, 0x33 / 255))).toBeLessThan(4.5);
  });
});

/**
 * Модальные окна: плашки, кружки и столбики.
 *
 * v4.32.409. Тот же изъян, что в 407-м и 408-м, в последних не пройденных
 * местах: подложка писалась как `цвет + 'NN'`, а содержимое на ней бралось из
 * палитры — то есть проверялось на контраст со СТРАНИЦЕЙ, а не с подложкой,
 * которую само же и получило. На палитре по умолчанию в светлой теме это
 * давало 4.42:1 у номера в списке активных и у значка документа, 3.99:1 у
 * кружка «прочитали» и 4.39:1 у кнопки «Восстановить» — при пороге 4.5:1. С
 * выбранным пользователем акцентом `primary` меняется, и промах становится
 * больше.
 *
 * Отдельный случай — столбики «Активность за 7 дней»: не-сегодняшний столбик
 * рисовался как `primary + '55'` и давал 1.65:1 (светлая) / 1.42:1 (тёмная)
 * относительно поверхности окна. Столбик — единственный носитель величины,
 * порог графики 3:1 (WCAG 1.4.11), то есть шести дней из семи на графике
 * фактически не было видно.
 */
describe('модалки: плашки, кружки и столбики', () => {
  const accents = ACCENT_SWATCHES.map((sw) => sw.hex);

  describe.each(palettes)('%s тема', (_name, p) => {
    test('плашка значка документа считается от фона списка', () => {
      const tint = badgeTint(p, 'accent', p.background);
      expect(tint.fill).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(contrast(tint.ink, tint.fill)).toBeGreaterThanOrEqual(4.5);
    });

    test('плашки на поверхности окна: номер, вкладка реакции, «Восстановить»', () => {
      const tint = badgeTint(p, 'accent', p.surface);
      expect(tint.fill).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(contrast(tint.ink, tint.fill)).toBeGreaterThanOrEqual(4.5);
    });

    test('столбики активности видны на поверхности окна', () => {
      // Порог графики: столбик — единственный носитель величины.
      // Сегодняшний день различается не только цветом: под каждым столбиком
      // стоит его дата, поэтому 1.4.1 здесь не нарушается.
      expect(contrast(p.accent, p.surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(p.textMuted, p.surface)).toBeGreaterThanOrEqual(3);
    });

    test('значок в журнале администратора читается на своей подложке', () => {
      // Порядок обхода союза: добавление тона ломает сборку теста, а не молча
      // проходит мимо проверки.
      const tones: Record<AdminLogTone, true> = {
        primary: true, accent: true, success: true, warning: true,
        error: true, star: true, textSecondary: true, textMuted: true,
      };
      for (const tone of Object.keys(tones) as AdminLogTone[]) {
        const plate = tintedPlate(p[tone], p.surface, 3);
        expect(plate.fill).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(contrast(plate.ink, plate.fill)).toBeGreaterThanOrEqual(3);
      }
    });

    test('линия между записями журнала не бледнее прежней полупрозрачной', () => {
      const was = mix(p.border, p.surface, 0x66 / 255);
      expect(contrast(p.border, p.surface)).toBeGreaterThanOrEqual(contrast(was, p.surface));
    });

    test('кружок личности читается при любом зерне', () => {
      for (let seed = 0; seed < 360; seed += 15) {
        const circle = identityAvatar(seed);
        expect(contrast(circle.ink, circle.fill)).toBeGreaterThanOrEqual(4.5);
      }
    });

    test.each(accents)('с акцентом %s плашки остаются читаемыми', (hex) => {
      const c = applyAccent(p, hex);
      for (const host of [c.surface, c.background]) {
        const tint = badgeTint(c, 'accent', host);
        expect(tint.fill).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(contrast(tint.ink, tint.fill)).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  test('прежний столбик «не сегодня» не дотягивал до порога графики', () => {
    for (const [, p] of palettes) {
      expect(contrast(mix(p.primary, p.surface, 0x55 / 255), p.surface)).toBeLessThan(3);
    }
  });

  test('прежние плашки не дотягивали до порога текста', () => {
    // v4.32.529: те же приколоченные значения и по той же причине — см.
    // «в светлой теме акцент на прежней плашке не дотягивал».
    const WAS_ACCENT = '#036B96';
    const WAS_PRIMARY = '#0068D6';
    const p = lightColors;
    // Номер в списке активных и значок документа.
    expect(contrast(WAS_ACCENT, mix(WAS_PRIMARY, p.surface, 0x33 / 255))).toBeLessThan(4.5);
    expect(contrast(WAS_ACCENT, mix(WAS_PRIMARY, p.background, 0x22 / 255))).toBeLessThan(4.5);
    // Кружок «прочитали».
    expect(contrast(WAS_ACCENT, mix(WAS_PRIMARY, p.surface, 0x44 / 255))).toBeLessThan(4.5);
    // Кнопка «Восстановить» — надпись бралась тем же `primary`, что и подложка.
    // Прежние бренды приколочены по той же причине: живая палитра здесь
    // утверждала бы, что сегодняшняя кнопка тоже нечитаема, а это уже неправда.
    const WAS_PRIMARY_BY_THEME: ReadonlyArray<readonly [string, string]> = [
      ['dark', '#3d5afe'],
      ['light', WAS_PRIMARY],
    ];
    for (const [name, wasPrimary] of WAS_PRIMARY_BY_THEME) {
      const surface = name === 'dark' ? darkColors.surface : lightColors.surface;
      expect(contrast(wasPrimary, mix(wasPrimary, surface, 0x22 / 255))).toBeLessThan(4.5);
    }
  });

  test('полупрозрачная подложка не поддаётся измерению', () => {
    // Ради чего вся правка: восьмизначное значение `parseHex` не разбирает,
    // `contrastRatio` отвечает 1, и проверка перестаёт быть проверкой.
    expect(contrastRatio(lightColors.accent, lightColors.primary + '55')).toBe(1);
  });
});

describe('обои: лента поверх выбранного пользователем фона', () => {
  /** Обои, как их хранит экран: null — «без обоев». */
  const asWallpaper = (value: string | null): Wallpaper | null =>
    value === null ? null : { type: 'color', value };

  it('в наборе есть и тёмные, и светлые обои', () => {
    // До v4.32.410 все одиннадцать были тёмными, и светлая тема на них не
    // проверялась ни разу: чернила брались от палитры, а не от обоев.
    const solid = WALLPAPER_PRESETS.filter((w) => w.value !== null);
    const light = solid.filter((w) => luminance(w.value as string) > 0.5);
    const dark = solid.filter((w) => luminance(w.value as string) <= 0.5);
    expect(light.length).toBeGreaterThanOrEqual(4);
    expect(dark.length).toBeGreaterThanOrEqual(4);
  });

  it('каждые обои названы и записаны непрозрачным #RRGGBB', () => {
    const labels = new Set<string>();
    for (const preset of WALLPAPER_PRESETS) {
      expect(preset.label.trim()).not.toBe('');
      expect(labels.has(preset.label)).toBe(false);
      labels.add(preset.label);
      if (preset.value !== null) expect(preset.value).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(WALLPAPER_PRESETS[0].value).toBeNull();
  });

  describe.each(palettes)('%s тема', (_name, p) => {
    test.each(WALLPAPER_PRESETS.map((w) => [w.label, w.value] as const))(
      'на обоях «%s» плашка ленты читается',
      (_label, value) => {
        const feed = feedGround(p, asWallpaper(value));
        expect(feed.known).toBe(true);
        expect(feed.ground).toBe(value ?? p.background);
        // Текст и вторичный текст — порог текста; приглушённый и цветные —
        // графический порог: ими не пишут абзацы.
        expect(contrast(feed.quiet.ink.text, feed.quiet.fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(feed.quiet.ink.secondary, feed.quiet.fill)).toBeGreaterThanOrEqual(4.5);
        for (const ink of [feed.quiet.ink.muted, feed.quiet.ink.accent, feed.quiet.ink.error, feed.quiet.ink.star, feed.quiet.ink.success]) {
          expect(contrast(ink, feed.quiet.fill)).toBeGreaterThanOrEqual(3);
        }
        expect(contrast(feed.loud.ink, feed.loud.fill)).toBeGreaterThanOrEqual(4.5);
      },
    );

    test.each(WALLPAPER_PRESETS.map((w) => [w.label, w.value] as const))(
      'на обоях «%s» прежняя плашка от палитры не читалась бы',
      (_label, value) => {
        // Прежний код: подложка 'rgba(128, 128, 128, 0.25)' поверх обоев и
        // текст colors.textSecondary от палитры. Проверка не тавтологична
        // ровно там, где светлота обоев спорит со светлотой темы.
        const ground = value ?? p.background;
        const wasQuiet = mix('#808080', ground, 0.25);
        const opposed = luminance(ground) > 0.5 !== (p === lightColors);
        if (!opposed) return;
        expect(contrast(p.textSecondary, wasQuiet)).toBeLessThan(4.5);
      },
    );
  });

  it('поверх снимка чернила не цветные: чужой кадр не измерить', () => {
    const feed = feedGround(darkColors, { type: 'image', value: 'file:///photo.jpg' });
    expect(feed.known).toBe(false);
    expect(feed.ground).toBe(mediaScrim.fill);
    expect(feed.quiet.fill).toBe(mediaScrim.bar);
    // Худший случай подложки — белый снимок под 60% чёрного.
    const worst = mix(mediaScrim.fill, '#ffffff', mediaScrim.barAlpha);
    expect(contrast(feed.quiet.ink.text, worst)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(feed.quiet.ink.secondary, worst)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(feed.quiet.ink.muted, worst)).toBeGreaterThanOrEqual(3);
    expect(contrast(feed.loud.ink, worst)).toBeGreaterThanOrEqual(4.5);
    for (const ink of [feed.quiet.ink.accent, feed.quiet.ink.error, feed.quiet.ink.star, feed.quiet.ink.success]) {
      expect(ink).toBe(mediaScrim.ink);
    }
  });

  it('красный из mediaScrim на полупрозрачной полосе не дотягивает до 3:1', () => {
    // Почему в scrimInk нет цветных чернил: на самой подложке кадра красный
    // доказан, а на полосе поверх белого снимка — нет.
    const worst = mix(mediaScrim.fill, '#ffffff', mediaScrim.barAlpha);
    expect(contrast(mediaScrim.error, worst)).toBeLessThan(3);
    expect(contrast(mediaScrim.error, mediaScrim.fill)).toBeGreaterThanOrEqual(4.5);
  });

  describe('градиентные обои: `ground` — худшая точка градиента, а не его основное поле', () => {
    // Градиент неоднороден, поэтому «цвет под лентой» у него — не `base`, а та
    // точка, где пятна утащили поверхность дальше всего В СТОРОНУ чернил:
    // у тёмного полотна самая светлая, у светлого — самая тёмная. Плашка,
    // доказанная против неё, читается и над всем остальным полем.
    // Пятна перекрываются (rx у большинства ≈ 0.9 — почти вся ширина), поэтому
    // худший случай считается по всем подмножествам и порядкам наложения:
    // так значение не зависит от того, в каком порядке они перечислены.
    const composite = (base: string, blobs: readonly { color: string; opacity: number }[]): string => {
      let worst: string | null = null;
      const toward = luminance(base) <= 0.5 ? 1 : -1;
      const walk = (acc: string, rest: readonly { color: string; opacity: number }[]) => {
        if (worst === null || (luminance(acc) - luminance(worst)) * toward > 0) worst = acc;
        rest.forEach((b, i) => walk(mix(b.color, acc, b.opacity), rest.filter((_, j) => j !== i)));
      };
      walk(base, blobs);
      return worst as unknown as string;
    };

    test.each(WALLPAPER_MESHES.map((m) => [m.label, m.id] as const))(
      'у градиента «%s» объявленный `ground` совпадает с посчитанным',
      (_label, id) => {
        const mesh = meshById(id);
        expect(mesh).not.toBeNull();
        expect(mesh?.base).toMatch(/^#[0-9a-f]{6}$/);
        expect(mesh?.ground).toBe(composite(mesh!.base, mesh!.blobs));
      },
    );

    it('у градиентов уникальные ключи и названия, и есть светлые и тёмные', () => {
      const ids = new Set(WALLPAPER_MESHES.map((m) => m.id));
      const labels = new Set(WALLPAPER_MESHES.map((m) => m.label));
      expect(ids.size).toBe(WALLPAPER_MESHES.length);
      expect(labels.size).toBe(WALLPAPER_MESHES.length);
      const light = WALLPAPER_MESHES.filter((m) => luminance(m.base) > 0.5);
      expect(light.length).toBeGreaterThanOrEqual(2);
      expect(WALLPAPER_MESHES.length - light.length).toBeGreaterThanOrEqual(2);
    });

    it('незнакомый ключ градиента не роняет ленту, а возвращает её на фон темы', () => {
      // Ключ приходит из хранилища: набор мог поменяться между версиями.
      const feed = feedGround(darkColors, { type: 'mesh', value: 'нет-такого' });
      expect(meshById('нет-такого')).toBeNull();
      expect(feed.known).toBe(true);
      expect(feed.ground).toBe(darkColors.background);
    });

    describe.each(palettes)('%s тема', (_name, p) => {
      test.each(WALLPAPER_MESHES.map((m) => [m.label, m.id] as const))(
        'на градиенте «%s» плашка ленты читается в худшей его точке',
        (_label, id) => {
          const feed = feedGround(p, { type: 'mesh', value: id });
          expect(feed.known).toBe(true);
          expect(feed.ground).toBe(meshById(id)?.ground);
          expect(contrast(feed.quiet.ink.text, feed.quiet.fill)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(feed.quiet.ink.secondary, feed.quiet.fill)).toBeGreaterThanOrEqual(4.5);
          for (const ink of [feed.quiet.ink.muted, feed.quiet.ink.accent, feed.quiet.ink.error, feed.quiet.ink.star, feed.quiet.ink.success]) {
            expect(contrast(ink, feed.quiet.fill)).toBeGreaterThanOrEqual(3);
          }
          expect(contrast(feed.loud.ink, feed.loud.fill)).toBeGreaterThanOrEqual(4.5);
        },
      );
    });
  });

  it('снимок обоев не выдаётся за цвет фона', () => {
    // Живая ошибка до v4.32.410: выбор фото из галереи сохранялся как
    // { type: 'color', value: 'file://…' } и уходил прямо в backgroundColor,
    // где RN его игнорировал — кнопка «Выбрать фото» ничего не делала.
    const feed = feedGround(lightColors, { type: 'image', value: 'file:///photo.jpg' });
    expect(feed.ground).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('пузыри переписки: всё внутри — от заливки пузыря', () => {
  const accents = ACCENT_SWATCHES.map((sw) => sw.hex);
  /** Все четыре пузыря: своя и чужая реплика в личной и групповой переписке. */
  const shapes: [string, boolean, 'chat' | 'group'][] = [
    ['свой в личной', true, 'chat'],
    ['чужой в личной', false, 'chat'],
    ['свой в групповой', true, 'group'],
    ['чужой в групповой', false, 'group'],
  ];

  describe.each(palettes)('%s тема', (_name, p) => {
    describe.each(accents)('акцент %s', (hex) => {
      const c = applyAccent(p, hex);
      test.each(shapes)('%s: подписи и значки читаются', (_shape, mine, kind) => {
        const b = bubbleSurface(c, mine, kind);
        // Текст и вторичные подписи — порог текста.
        expect(contrast(b.ink.text, b.fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(b.ink.secondary, b.fill)).toBeGreaterThanOrEqual(4.5);
        // Приглушённое и значки — графика.
        expect(contrast(b.ink.muted, b.fill)).toBeGreaterThanOrEqual(3);
        expect(contrast(b.icon, b.fill)).toBeGreaterThanOrEqual(3);
        // Вложенный блок: сперва подложка от пузыря, потом чернила от неё.
        expect(b.plate.fill).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrast(b.plate.ink.text, b.plate.fill)).toBeGreaterThanOrEqual(4.5);
      });

      test('линия внутри своего пузыря берёт графический порог', () => {
        // В чужом пузыре линия остаётся `border` — тихая по замыслу, и
        // поднимать её здесь значило бы утяжелить весь список.
        for (const kind of ['chat', 'group'] as const) {
          const b = bubbleSurface(c, true, kind);
          expect(contrast(b.hairline, b.fill)).toBeGreaterThanOrEqual(3);
        }
        expect(bubbleSurface(c, false, 'chat').hairline).toBe(c.border);
      });
    });

    test('заливка пузыря — та же, что рисует экран', () => {
      // Расхождение здесь означало бы, что чернила считаются от чужой заливки:
      // именно так до v4.32.398 звезда «в избранном» считалась от bubbleOut в
      // групповом пузыре, залитом primary.
      expect(bubbleSurface(p, true, 'chat').fill).toBe(p.bubbleOut);
      expect(bubbleSurface(p, false, 'chat').fill).toBe(p.surfaceHigh);
      expect(bubbleSurface(p, true, 'group').fill).toBe(p.primary);
      expect(bubbleSurface(p, false, 'group').fill).toBe(p.surface);
    });
  });

  it('прежний полупрозрачный белый в своём пузыре не читался', () => {
    // Так писались размер файла, ключ контакта, «Показать больше», подписи
    // под картой — восемь компонентов, все мимо порога 4.5.
    expect(contrast(mix('#ffffff', lightColors.bubbleOut, 0.7), lightColors.bubbleOut)).toBeLessThan(4.5);
    // В групповом пузыре хуже: заливка — выбранный акцент, и порога не берёт
    // ни один из девяти, а на «малиновом» и «красном» не берётся и
    // графический порог 3:1.
    for (const hex of ACCENT_SWATCHES.map((sw) => sw.hex)) {
      const c = applyAccent(lightColors, hex);
      expect(contrast(mix('#ffffff', c.primary, 0.7), c.primary)).toBeLessThan(4.5);
    }
    for (const hex of ['#e11d60', '#d73b30']) {
      const c = applyAccent(lightColors, hex);
      expect(contrast(mix('#ffffff', c.primary, 0.7), c.primary)).toBeLessThan(3);
    }
  });

  it('прежняя волосяная линия не брала даже графический порог', () => {
    for (const [, p] of palettes) {
      expect(contrast(mix('#ffffff', p.bubbleOut, 0.3), p.bubbleOut)).toBeLessThan(3);
    }
  });

  it('прежняя плашка превью во входящем пузыре была невидима', () => {
    // Заливка `surfaceHigh` поверх пузыря, залитого тем же `surfaceHigh`.
    for (const [, p] of palettes) {
      expect(contrast(p.surfaceHigh, p.surfaceHigh)).toBe(1);
      expect(bubbleSurface(p, false, 'chat').plate.fill).not.toBe(p.surfaceHigh);
    }
  });

  it('прозрачный цвет вообще нельзя измерить', () => {
    // Причина, по которой популяция rgba(...) жила незамеченной: как и склейка
    // с прозрачностью (v4.32.407), она отвечает 1 на любой вопрос.
    expect(contrastRatio('rgba(255,255,255,0.7)', darkColors.bubbleOut)).toBe(1);
  });
});

/**
 * v4.32.412. Плёнка под окном.
 *
 * «Затемнить приложение под диалогом» было написано пятьюдесятью местами и
 * тринадцатью разными числами — от 0.3 до 0.75. Мерить тут нужно не текст:
 * текст лежит на непрозрачном листе окна. Мерить нужно САМ лист — в светлой
 * теме он белый и лежит на затемнённом белом фоне, и отделяет их только
 * плёнка. Это графическая граница, порог 3:1.
 */
describe('плёнка под окном', () => {
  /** Плёнка `rgba(0,0,0,a)` поверх кадра — результат наложения. */
  const film = (frame: string, a: number): string => mix('#000000', frame, a);

  it('лист окна отделяется от погашенного экрана', () => {
    // Светлая тема — единственная, где плёнка вообще может отделить лист:
    // лист белый, фон белый, между ними только затемнение.
    const dimmed = film(lightColors.background, scrim.modalAlpha);
    expect(contrast(lightColors.surface, dimmed)).toBeGreaterThanOrEqual(3);
  });

  it('прежние значения границы не держали', () => {
    // Не тавтология: 0.3 стоял на выборе оттенка кожи в переписке, 0.4 —
    // на четырёх окнах в группах и на листе гифок.
    expect(contrast(lightColors.surface, film(lightColors.background, 0.3))).toBeLessThan(3);
    expect(contrast(lightColors.surface, film(lightColors.background, 0.4))).toBeLessThan(
      contrast(lightColors.surface, film(lightColors.background, scrim.modalAlpha)),
    );
  });

  it('в тёмной теме границу держит не плёнка', () => {
    // Замер, объясняющий, почему прозрачность нельзя подбирать на глаз: тёмный
    // лист на затемнённом тёмном фоне не отделяется ни при каком значении.
    for (const a of [0.3, 0.5, 0.75, 0.9]) {
      expect(contrast(darkColors.surface, film(darkColors.background, a))).toBeLessThan(1.3);
    }
  });

  it('плёнка просмотрщика гасит приложение, а не притеняет его', () => {
    // Под полноэкранным медиа приложение должно исчезнуть: белый экран уходит
    // за порог текста даже как фон.
    expect(scrim.viewerAlpha).toBeGreaterThan(scrim.modalAlpha);
    expect(contrast('#ffffff', film('#ffffff', scrim.viewerAlpha))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', film('#ffffff', scrim.modalAlpha))).toBeLessThan(4.5);
  });

  it('числом и строкой записана одна и та же прозрачность', () => {
    expect(scrim.modal).toBe(`rgba(0, 0, 0, ${scrim.modalAlpha})`);
    expect(scrim.viewer).toBe(`rgba(0, 0, 0, ${scrim.viewerAlpha})`);
  });

  it('плёнка под окном и плашка поверх кадра — разные вещи', () => {
    // Порог у них разный: под окном меряется лист (3:1), поверх кадра —
    // белые чернила на худшем, то есть белом, кадре (4.5:1). Отсюда и
    // разные значения; сводить их в одно было бы ошибкой.
    expect(scrim.modal).not.toBe(mediaScrim.bar);
    const worstFrame = film('#ffffff', mediaScrim.barAlpha);
    expect(contrast(mediaScrim.ink, worstFrame)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(mediaScrim.ink, film('#ffffff', scrim.modalAlpha))).toBeLessThan(4.5);
  });

  it('прежние плашки поверх кадра белых букв не держали', () => {
    // Не тавтология: 0.35 стояла на строке авторства карты, 0.5 — на подписи
    // истории, 0.52 — на счётчике «+N» в сетке снимков.
    for (const a of [0.35, 0.5, 0.52]) {
      expect(contrast(mediaScrim.ink, film('#ffffff', a))).toBeLessThan(4.5);
    }
    expect(contrast(mediaScrim.ink, film('#ffffff', 0.35))).toBeLessThan(3);
  });
});

/**
 * Содержимое пузыря, нарисованное самим экраном.
 *
 * Раунд 411 привёл к `bubbleSurface` компоненты-пузыри, но самый крупный
 * набор — текст сообщения, шапка «Переслано», блок перевода, плашка «один
 * просмотр» — рисуется прямо в `ChatScreen`, и там всё это писалось белым с
 * прозрачностью по признаку `isOut`. Замерено в 413-м на светлой теме:
 * подвал 3.40:1 при пороге 4.5, линия под «Переслано» 1.70:1 при пороге 3,
 * плашка «один просмотр» во входящем пузыре — `surfaceHigh` поверх
 * `surfaceHigh`, то есть ровно 1.00:1.
 *
 * Признак «на своей заливке» не равен признаку «исходящее»: у сообщения из
 * одних эмодзи пузыря нет вовсе, под ним фон списка, и белый там был бы белым по белому.
 * Поэтому `bubbleSurfaceOn` получает заливку, а не сторону.
 */
describe('содержимое пузыря выводится из заливки', () => {
  const hosts = (c: AppColors): Array<[string, string, boolean]> => [
    ['свой', c.bubbleOut, true],
    ['чужой', c.surfaceHigh, false],
    ['группа, свой', c.primary, true],
    ['эмодзи без пузыря', c.background, false],
  ];

  for (const [theme, c] of [['тёмная', darkColors], ['светлая', lightColors]] as Array<[string, AppColors]>) {
    for (const [name, fill, mine] of hosts(c)) {
      const b = bubbleSurfaceOn(c, fill, mine);

      it(`${theme}/${name}: подвал и служебные подписи читаются`, () => {
        expect(contrastRatio(b.ink.text, fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(b.ink.secondary, fill)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${theme}/${name}: линия и иконка держат графический порог`, () => {
        expect(contrastRatio(b.icon, fill)).toBeGreaterThanOrEqual(3);
        if (mine) {
          // На своей заливке линия — графика поверх цвета, её тянут чернила.
          expect(contrastRatio(b.hairline, fill)).toBeGreaterThanOrEqual(3);
        } else {
          // На чужом пузыре и на фоне списка линия остаётся `border`: она и
          // задумана тихим разделителем, а не границей контрола, и поднимать
          // её здесь значило бы утяжелить весь список (решение 411-го).
          expect(b.hairline).toBe(c.border);
        }
      });

      it(`${theme}/${name}: вложенная плашка отличается от пузыря и читаема`, () => {
        expect(b.plate.fill).not.toBe(fill);
        expect(contrastRatio(b.plate.ink.text, b.plate.fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(b.plate.ink.secondary, b.plate.fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(b.plate.ink.muted, b.plate.fill)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(b.plate.ink.accent, b.plate.fill)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('bubbleSurface — частный случай bubbleSurfaceOn', () => {
    for (const c of [darkColors, lightColors]) {
      expect(bubbleSurface(c, true, 'chat')).toEqual(bubbleSurfaceOn(c, c.bubbleOut, true));
      expect(bubbleSurface(c, false, 'chat')).toEqual(bubbleSurfaceOn(c, c.surfaceHigh, false));
      expect(bubbleSurface(c, true, 'group')).toEqual(bubbleSurfaceOn(c, c.primary, true));
      expect(bubbleSurface(c, false, 'group')).toEqual(bubbleSurfaceOn(c, c.surface, false));
    }
  });

  /**
   * `DocBubble`, `ContactCardBubble`, `VoicePlayer`, `GifBubble` и
   * `LinkPreview` общие у переписки и групп, а свой пузырь у них залит
   * по-разному. До 413-го они звали `bubbleSurface(colors, mine)` без рода и
   * в тёмной теме получали на #3d5afe чернила, подобранные под #1a2e5e:
   * вторичный текст 2.05:1 при пороге 4.5, приглушённый 1.20:1 при пороге 3.
   */
  it('род пузыря нельзя перепутать: чернила группы считаются по её заливке', () => {
    for (const c of [darkColors, lightColors]) {
      const chat = bubbleSurface(c, true, 'chat');
      const grp = bubbleSurface(c, true, 'group');
      expect(grp.fill).toBe(c.primary);
      expect(contrastRatio(grp.ink.secondary, grp.fill)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(grp.ink.muted, grp.fill)).toBeGreaterThanOrEqual(3);
      // В тёмной теме заливки расходятся, и подстановка чужих чернил
      // проваливает порог — значит проверка выше не пустая.
      if (chat.fill !== grp.fill) {
        expect(contrastRatio(chat.ink.muted, grp.fill)).toBeLessThan(3);
      }
    }
  });
});

/**
 * Тост входящего сообщения и волна нажатия на цветной кнопке (v4.32.414).
 *
 * Оба места объединяет не картинка, а форма дефекта: цвет был верен, но верен
 * по правилу, записанному где-то ещё. Тост — «тёмный в обеих темах», и три его
 * цвета были вписаны вручную; волна — «белая», и белой ей позволял быть
 * инвариант `normalizeAccent` из соседнего файла.
 */
describe('тост и волна нажатия', () => {
  it('тост читается: он и есть приподнятая поверхность тёмной палитры', () => {
    expect(toastSurface.fill).toBe(darkColors.surfaceHigh);
    expect(contrast(toastSurface.ink.text, toastSurface.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(toastSurface.ink.secondary, toastSurface.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(toastSurface.ink.muted, toastSurface.fill)).toBeGreaterThanOrEqual(3);
  });

  /**
   * Проверка не на значения, а на происхождение: чернила тоста обязаны быть
   * теми же, что даёт общий `inkOn`. Совпадающий набор, выписанный руками,
   * прошёл бы проверку выше и разошёлся бы с палитрой при первой её правке.
   */
  it('чернила тоста не выписаны, а посчитаны', () => {
    expect(toastSurface.ink).toEqual(inkOn(darkColors, darkColors.surfaceHigh));
  });

  /**
   * У отклика на касание порога WCAG нет, и выдумывать его здесь незачем.
   * Проверяется то, что проверяемо: волна поверх заливки от заливки отличима,
   * тогда как токен `ripple` на своём же акценте не даёт ничего.
   */
  it('волна нажатия видна на цветной кнопке, а токен `ripple` — нет', () => {
    for (const c of [darkColors, lightColors]) {
      for (const sw of ACCENT_SWATCHES) {
        const p = applyAccent(c, normalizeAccent(sw.hex));
        const ink = contrastingInk(p.primary);
        expect(rippleOn(p.primary)).toBe(withAlpha(ink, 0.3));
        expect(contrast(mix(ink, p.primary, 0.3), p.primary)).toBeGreaterThanOrEqual(1.4);
        expect(contrast(mix(p.primary, p.primary, 0.2), p.primary)).toBe(1);
      }
    }
  });

  /**
   * Сегодня `normalizeAccent` держит акцент тёмным, и на всех девяти образцах
   * волна выходит белой — байт в байт прежним литералом. Смысл перехода виден
   * там, куда образцы не достают: на светлой заливке волна обязана потемнеть.
   */
  it('волна следует за заливкой, а не за договорённостью о белом', () => {
    expect(rippleOn('#ffffff')).toBe(withAlpha('#000000', 0.3));
    expect(rippleOn('#000000')).toBe(withAlpha('#ffffff', 0.3));
    for (const sw of ACCENT_SWATCHES) {
      expect(rippleOn(normalizeAccent(sw.hex) ?? '')).toBe(withAlpha('#ffffff', 0.3));
    }
  });

  /**
   * Вспышка перехода к сообщению. В 401-м она получила общий `rowMark`, но
   * перешли на него только личные чаты: в группах остался литерал со старым
   * значением звезды. Здесь проверяется сам источник — что «сюда меня привёл
   * поиск» в обеих палитрах считается от `star`, а не от копии её прошлого.
   */
  it('вспышка перехода берётся от звезды палитры', () => {
    for (const c of [darkColors, lightColors]) {
      expect(rowMark(c, 'found', 0)).toBe(withAlpha(c.star, 0));
      expect(rowMark(c, 'found', 0.35)).toBe(withAlpha(c.star, 0.35));
      // Плёнка на 0.35 сдвигает строку заметно — иначе вспышки не видно.
      expect(contrast(mix(c.star, c.surface, 0.35), c.surface)).toBeGreaterThanOrEqual(1.3);
    }
  });
});

/**
 * Сюжеты (v4.32.415).
 *
 * Здесь встречаются два разных случая, и до этого раунда они были написаны
 * одинаково — белым с прозрачностью. Разница не в цвете, а в том, что под ним:
 * поверх ЧУЖОГО кадра измерить нельзя ничего, пока под содержимым нет плёнки,
 * а поверх фона, который только что выбрал автор, всё измеримо точно.
 */
describe('сюжеты: поверх чужого кадра и поверх выбранного цвета', () => {
  /** Панель поверх худшего (белого) и лучшего (чёрного) кадра. */
  const barOver = (frame: string): string => mix(mediaScrim.fill, frame, mediaScrim.barAlpha);
  const frames = ['#ffffff', '#000000'];

  it('поле ввода поверх панели читается над любым кадром', () => {
    for (const frame of frames) {
      const bar = barOver(frame);
      const field = mix(mediaScrim.fill, bar, mediaScrim.fieldAlpha);
      expect(contrast(mediaScrim.ink, field)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(mediaScrim.inkMuted, field)).toBeGreaterThanOrEqual(4.5);
      // Рамка отделяет поле от панели — графическая граница к обоим сразу.
      expect(contrast(mediaScrim.inkMuted, field)).toBeGreaterThanOrEqual(3);
      expect(contrast(mediaScrim.inkMuted, bar)).toBeGreaterThanOrEqual(3);
    }
  });

  it('прежнее поле светлело и порога не брало', () => {
    // Было 'rgba(255,255,255,0.12)' — поле СВЕТЛЕЕ панели. Поверх белого кадра
    // панель даёт #666666, поле на ней — светло-серое, и белый текст в нём
    // порога уже не берёт. Затемнение вместо осветления сохраняет запас в
    // обоих пределах: над белым кадром и над чёрным.
    const lightened = mix(mediaScrim.ink, barOver('#ffffff'), 0.12);
    expect(contrast(mediaScrim.ink, lightened)).toBeLessThan(4.5);
  });

  it('дорожка индикатора сама себе плёнка', () => {
    // Полоска высотой 2 px лежит прямо на кадре: плёнки под ней нет и быть не
    // может — она сама этой плёнкой и работает. Непройденная часть — `bar`,
    // пройденная — чернила на ней.
    for (const frame of frames) {
      expect(contrast(mediaScrim.ink, barOver(frame))).toBeGreaterThanOrEqual(3);
    }
  });

  it('прежняя дорожка исчезала на светлом кадре', () => {
    // Было 'rgba(255,255,255,0.3)': белое поверх белого кадра — и пройденная
    // часть от непройденной не отличалась вовсе.
    const whitish = mix(mediaScrim.ink, '#ffffff', 0.3);
    expect(contrast(mediaScrim.ink, whitish)).toBeLessThan(3);
  });

  it('фоны текстовой сторис известны — чернила на них считаются', () => {
    for (const bg of [...STORY_TEXT_BACKGROUNDS, STORY_TEXT_VIEWER_BG]) {
      const ink = inkOn(darkColors, bg);
      expect(contrast(ink.text, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(ink.secondary, bg)).toBeGreaterThanOrEqual(4.5);
      // Кнопка «Опубликовать» — вложенная плашка на том же фоне.
      const plate = nestedFill(bg);
      expect(plate).not.toBe(bg);
      expect(contrast(inkOn(darkColors, plate).text, plate)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('фон сторис выбирает автор, и теме он не подчиняется', () => {
    for (const [, p] of palettes) {
      for (const bg of STORY_TEXT_BACKGROUNDS) {
        expect(bg).not.toBe(p.background);
        expect(bg).not.toBe(p.surface);
      }
    }
  });
});

/**
 * Приглушённая метка на известной подложке (v4.32.416).
 *
 * Две последние склейки цвета с прозрачностью. Обе дожили не потому, что были
 * безобидны, а потому, что храповик искал кавычку вплотную к плюсу: одна
 * ставила между ними тернар, вторая — имя константы. Ниже проверяется и то,
 * что цвет теперь измерим, и то, что прежняя запись измерению не поддавалась.
 */
describe('приглушённая метка на известной подложке', () => {
  const BORDER_ALPHA = 0x55 / 255;
  const TRAIL_ALPHA = 0xaa / 255;

  it.each(['neutral', 'ok', 'warn', 'error'] as const)(
    'рамка полоски «%s» непрозрачна и остаётся тише чернил',
    (tone) => {
      for (const [name, p] of palettes) {
        const { ink, fill, border } = bannerColors(tone, p);
        expect([name, /^#[0-9a-f]{6}$/.test(border)]).toEqual([name, true]);
        expect(border).toBe(fadedOn(ink, fill, BORDER_ALPHA));
        // Намёк, а не носитель смысла: рамка не спорит с чернилами.
        expect(contrast(border, fill)).toBeLessThan(contrast(ink, fill));
      }
    }
  );

  it('прежняя рамка не измерялась вовсе', () => {
    // `ink + '55'` — восьмизначный хекс: `parseHex` его не разбирает, и
    // `contrastRatio` отвечает 1 при любом цвете. Утверждать о такой рамке
    // можно было что угодно — проверка согласилась бы.
    for (const [name, p] of palettes) {
      expect([name, contrastRatio(p.error + '55', p.surfaceHigh)]).toEqual([name, 1]);
    }
  });

  it('столбик осциллограммы держит графический порог в обеих темах', () => {
    for (const [name, p] of palettes) {
      // Композер под записью — `colors.surface` и в переписке, и в группе.
      const trail = fadedOn(p.error, p.surface, TRAIL_ALPHA, 3);
      expect([name, contrast(trail, p.surface) >= 3]).toEqual([name, true]);
      expect([name, contrast(p.error, p.surface) >= 3]).toEqual([name, true]);
      // Свежий столбик отличим от прошедших — иначе рисовать их порознь незачем.
      expect(contrast(p.error, trail)).toBeGreaterThan(1.1);
    }
  });

  it('приглушение поднимают до порога, а не до самого цвета', () => {
    for (const [name, p] of palettes) {
      // Запрошенная доля порог уже держит — цвет не трогают вовсе.
      expect(fadedOn(p.error, p.surface, TRAIL_ALPHA, 3)).toBe(fadedOn(p.error, p.surface, TRAIL_ALPHA));
      // Не держит — поднимают ровно до порога, а не до полной насыщенности.
      const lifted = fadedOn(p.error, p.surface, 0, 3);
      expect([name, contrast(lifted, p.surface) >= 3]).toEqual([name, true]);
      expect(lifted).not.toBe(p.error);
      // Нулевая доля без порога — это ровно подложка, метки не видно.
      expect(fadedOn(p.error, p.surface, 0)).toBe(p.surface.toLowerCase());
    }
  });
});

/**
 * Спойлер и подсветка найденного (v4.32.417).
 *
 * Оба лежат НА пузыре и оба были вписаны цветом, не зависящим ни от темы, ни
 * от пузыря: '#888' у спойлера (в трёх файлах сразу) и пара '#ffe082' с '#000'
 * у подсветки (в двух ветках одной функции). Оба измеримы — литерал разбирается
 * `parseHex`, — и потому дефект был виден бы сразу, если бы кто-нибудь замерил.
 */
describe('спойлер и подсветка найденного', () => {
  it('плашка спойлера видна на любом пузыре', () => {
    for (const [name, p] of palettes) {
      for (const mine of [false, true]) {
        const fill = bubbleSurface(p, mine).fill;
        // Букв на плашке нет — они прозрачны, — поэтому порог графический:
        // смысл несёт сам факт «здесь что-то закрыто».
        expect([name, mine, contrast(spoilerPlate(fill), fill) >= 3]).toEqual([name, mine, true]);
      }
    }
  });

  it('прежний серый спойлер на исходящем пузыре светлой темы почти пропадал', () => {
    expect(contrast('#888888', lightColors.bubbleOut)).toBeLessThan(3);
  });

  it('подсветка найденного отличима и от пузыря, и от буквы', () => {
    for (const [name, p] of palettes) {
      for (const mine of [false, true]) {
        const fill = bubbleSurface(p, mine).fill;
        const m = searchMark(p, fill);
        // Плашка к пузырю — метка, порог графический.
        expect([name, mine, contrast(m.fill, fill) >= 3]).toEqual([name, mine, true]);
        // Буква к плашке — текст, порог текстовый. Сперва заливка, потом
        // чернила: чернила считаются от полученной плашки, а не от пузыря.
        expect([name, mine, contrast(m.ink, m.fill) >= 4.5]).toEqual([name, mine, true]);
      }
    }
  });

  it('прежний бледный янтарь на белом пузыре не был виден вовсе', () => {
    expect(contrast('#ffe082', lightColors.surface)).toBeLessThan(3);
  });

  it('подсветка остаётся янтарём палитры, где порог уже взят', () => {
    // readableOn меняет светлоту, а не тон, и не трогает цвет вовсе, если
    // порог уже держится: на тёмной поверхности это ровно `star`.
    expect(searchMark(darkColors, darkColors.surface).fill.toLowerCase()).toBe(darkColors.star.toLowerCase());
  });
});

describe('профиль, выбор профиля и подтверждающие кнопки', () => {
  const themes: Array<[string, AppColors]> = [
    ['светлая', lightColors],
    ['тёмная', darkColors],
  ];

  for (const [theme, p] of themes) {
    const activeFill = tintedPlate(p.primary, p.surface).fill;
    const activeInk = inkOn(p, activeFill);

    it(`${theme}: активная карточка профиля читается на своей заливке`, () => {
      expect(contrast(activeInk.text, activeFill)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(activeInk.muted, activeFill)).toBeGreaterThanOrEqual(3);
    });

    it(`${theme}: белое на кнопке подтверждения выводится из самой кнопки`, () => {
      expect(contrast(primaryInk(p).text, p.primary)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: контур невыбранной кнопки виден на поверхности`, () => {
      expect(contrast(p.mutedFill, p.surface)).toBeGreaterThanOrEqual(3);
    });

    it(`${theme}: ссылка на X читается на странице профиля`, () => {
      const shown = accentOnFill(BRAND_X, p.background, p.accent);
      expect(contrast(shown, p.background)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // Проверки не-пустоты: старые вписанные значения ДОЛЖНЫ проваливать те же
  // пороги, иначе тесты выше ничего не стерегут.
  it('старая заливка активной карточки прятала имя профиля в светлой теме', () => {
    expect(contrast(lightColors.text, '#1a2540')).toBeLessThan(3);
  });

  it('старый контур типа группы был почти не виден в тёмной теме', () => {
    expect(contrast('#444444', darkColors.surface)).toBeLessThan(3);
    expect(contrast('#666666', darkColors.surface)).toBeLessThan(3.5);
  });

  it('фирменный голубой X не читался на светлой странице как есть', () => {
    expect(contrast(BRAND_X, lightColors.background)).toBeLessThan(4.5);
  });

  it('в тёмной теме фирменный цвет X уже проходит и остаётся собой', () => {
    expect(accentOnFill(BRAND_X, darkColors.background, darkColors.accent).toLowerCase()).toBe(BRAND_X);
  });
});

describe('QR-код: контракт со сканером, а не оформление', () => {
  it('код чёрно-белый в обеих темах', () => {
    expect(contrast(QR_CODE.ink, QR_CODE.fill)).toBe(21);
  });

  it('поле тишины непустое', () => {
    expect(QR_CODE.quietZone).toBeGreaterThanOrEqual(8);
  });

  it('без белой подложки код тонул бы в тёмной поверхности', () => {
    expect(contrast(QR_CODE.ink, darkColors.surface)).toBeLessThan(1.5);
  });
});

describe('последние вписанные цвета: кнопка, плёнка и карта', () => {
  const themes: Array<[string, AppColors]> = [
    ['светлая', lightColors],
    ['тёмная', darkColors],
  ];

  for (const [theme, p] of themes) {
    it(`${theme}: значок «в избранном» виден на поверхности`, () => {
      expect(contrast(p.star, p.surface)).toBeGreaterThanOrEqual(3);
    });
  }

  it('прежний оранжевый «в избранном» терялся на светлой поверхности', () => {
    expect(contrast('#ff9800', lightColors.surface)).toBeLessThan(3);
  });

  it('подписи поверх плёнки читаются — это одна и та же плёнка везде', () => {
    // GifPicker, GroupPhotoGrid и бейдж геолокации писали белым напрямую;
    // теперь все трое спрашивают чернила у mediaScrim, а не у себя.
    expect(contrast(mediaScrim.ink, mediaScrim.fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('бумага под тайлами карты — не цвет темы', () => {
    // Тёмная тема на этой бумаге не читается вовсе: 1.10:1. Это и есть
    // причина, по которой поверх карты пишут только через mediaScrim.
    expect(contrast(darkColors.text, MAP_PAPER)).toBeLessThan(1.5);
    expect(MAP_PAPER).toMatch(/^#[0-9a-f]{6}$/);
  });
});
