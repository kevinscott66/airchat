/**
 * Храповик на геометрию: кегль и скругление, вписанные числом.
 *
 * Тот же дефект, что paletteLiterals ловит у цвета, и та же история. В
 * design.md записаны и ритм (8/12/16/24), и шкала кегля (12–13 подпись, 15
 * основной текст, 17–24 заголовки), и диапазон скруглений (8–18). В
 * `theme.ts` под них есть токены. Пользовались ими 8 файлов из 102.
 *
 * Причина, найденная в 528-м, обидная: сами токены расходились с документом,
 * который описывали. `spacing` шёл шагом 4/8/14/20/28 против ритма 8/12/16/24,
 * `radius.sm` был 6 при нижней границе 8, `font.xs` — 11 при пороге 12. То
 * есть человек, честно взявший токен, получал не то, что написано в правилах,
 * и в следующий раз писал число руками. Токены были переписаны по документу;
 * этот тест не даёт разойтись им снова и не даёт расти остатку.
 *
 * Три разных утверждения, и смешивать их нельзя:
 *   1) порог читаемости — правило без исключений и без списка;
 *   2) шкалы токенов равны тому, что записано в design.md;
 *   3) числа руками — храповик: сколько было, столько и осталось.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { badgeDigit, font, radius, spacing, TOUCH_TARGET_MIN } from '../theme';

/** Корень исходников относительно этого теста. */
const SRC = join(__dirname, '..', '..');

/** Все .ts/.tsx под src, кроме тестов. */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      collect(full, out);
      continue;
    }
    if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Строки файла без комментариев. Копия разбора из paletteLiterals: там же
 * объяснено, почему `{/*` нужен отдельной веткой — иначе за нарушение
 * считается объяснение, почему нарушение убрали.
 */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*') || line.startsWith('{/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

/** Путь относительно src, с прямыми слэшами — ключ во всех списках. */
function relKey(full: string): string {
  return full.slice(SRC.length + 1).split('\\').join('/');
}

/** Числовые значения свойства в коде файла — не в комментариях. */
function numericValues(source: string, prop: string): number[] {
  const re = new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)\\b`, 'g');
  const out: number[] = [];
  for (const line of codeLines(source)) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) out.push(Number(m[1]));
  }
  return out;
}

/**
 * Порог читаемости.
 *
 * design.md: «вспомогательный текст — 12–13». Единственное исключение —
 * цифра счётчика внутри залитого кружка: ей отведён именованный токен
 * `badgeDigit`, и он именно поэтому токен, а не число: исключение, у которого
 * есть имя, видно в отличие от исключения, у которого есть только значение.
 *
 * Списка исключений у этого правила нет намеренно. В 528-м таких мест было
 * 123 в 45 файлах — от 8 до 11 кеглем, — и все они разобраны: 113 подняты до
 * `font.xs`, 10 названы счётчиками. Раз популяция обнулена, любое новое место
 * — это новое нарушение, а не остаток старого.
 */
describe('порог читаемости', () => {
  it('в приложении нет текста мельче 12', () => {
    const offenders: string[] = [];
    for (const file of collect(SRC)) {
      for (const v of numericValues(readFileSync(file, 'utf8'), 'fontSize')) {
        if (v < 12) offenders.push(`${relKey(file)}: fontSize ${v}`);
      }
    }
    // Что делать вместо: font.xs (12) — подпись, метка, время; badgeDigit
    // (10) — ТОЛЬКО цифра счётчика внутри заливки, и больше ничего.
    expect(offenders.join('\n')).toBe('');
  });

  it('исключение для счётчика названо и единственно', () => {
    expect(badgeDigit).toBe(10);
    expect(badgeDigit).toBeLessThan(font.xs);
  });
});

/**
 * Шкалы равны документу.
 *
 * Это не тавтология «токен равен себе»: числа здесь переписаны из design.md
 * руками, и тест падает, когда правят одну сторону, забыв другую. Именно так
 * шкалы и разошлись в первый раз — правило жило в документе, значение в коде,
 * и ничто их не связывало.
 */
describe('шкалы совпадают с design.md', () => {
  it('кегль: подпись 12–13, текст 15, заголовки 17–24', () => {
    expect(font).toEqual({ xs: 12, sm: 13, md: 15, lg: 17, xl: 20, xxl: 24 });
  });

  it('ритм: 8/12/16/24 с половиной и двойным шагом по краям', () => {
    expect(spacing).toEqual({ xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 });
  });

  it('скругления лежат в диапазоне 10–30 плюс круг', () => {
    const finite = Object.values(radius).filter((r) => r !== radius.full);
    expect(Math.min(...finite)).toBe(10);
    expect(Math.max(...finite)).toBe(30);
    // `full` — не число из диапазона, а способ сказать «круг»: величина берётся
    // заведомо больше половины любой стороны.
    expect(radius.full).toBeGreaterThan(1000);
  });

  it('минимальная цель касания — 44', () => {
    expect(TOUCH_TARGET_MIN).toBe(44);
  });
});

/**
 * Сколько чисел было вписано руками на момент 528-го.
 *
 * Как и в paletteLiterals, список может только укорачиваться, и «меньше» тоже
 * роняет тест: исправленный файл, оставивший себе прежнюю квоту, молча
 * освободит место под новое число.
 *
 * Файла, которого в списке нет, в списке быть и не должно: он не может завести
 * вписанное число вовсе.
 *
 * В 543-м из списка вышли Профиль и Настройки: их кегли пересчитываются под
 * выбранный размер текста, поэтому число там теперь не литерал, а аргумент
 * `sf(...)`. Квоты у них были 53 и 21 — обе обнулены целиком.
 */
const FONT_SIZE_BASELINE: Record<string, number> = {
  'ui/screens/FeedScreen.tsx': 72,
  'ui/screens/GroupsScreen.tsx': 60,
  'ui/screens/ChatScreen.tsx': 31,
  'ui/screens/ChatListScreen.tsx': 29,
  'ui/screens/ContactsScreen.tsx': 20,
  'ui/components/StoriesRow.tsx': 14,
  'ui/components/ProfileSelector.tsx': 12,
  'ui/components/modals/groups/GroupMessageInfoModal.tsx': 11,
  'ui/components/CallOverlay.tsx': 1,
  'ui/components/RelaySettingsSection.tsx': 10,
  'ui/components/modals/chat/ChatForwardModal.tsx': 10,
  'ui/components/modals/chat/ChatMessageInfoModal.tsx': 10,
  'ui/components/VpnSettingsSection.tsx': 8,
  'ui/components/modals/groups/GroupJoinRequestsModal.tsx': 8,
  'ui/components/modals/chat/ChatPollCreatorModal.tsx': 7,
  'ui/screens/chat-components/EmojiPanel.tsx': 7,
  'ui/components/modals/groups/GroupPollCreatorModal.tsx': 7,
  'ui/components/modals/groups/GroupReactionDetailModal.tsx': 7,
  'ui/components/modals/groups/GroupStatsModal.tsx': 7,
  'ui/screens/groups-components/PollBubble.tsx': 6,
  'ui/components/GifPicker.tsx': 6,
  'ui/components/MediaPreviewModal.tsx': 6,
  'ui/components/modals/chat/ChatScheduleModal.tsx': 6,
  'ui/components/modals/groups/GroupCreateModal.tsx': 6,
  'ui/components/modals/groups/GroupSeenByModal.tsx': 5,
  'ui/components/modals/groups/GroupSharedMediaModal.tsx': 6,
  'ui/screens/DiagnosticScreen.tsx': 6,
  'ui/screens/ForgotPasswordScreen.tsx': 6,
  'ui/components/modals/chat/ChatRecentlyDeletedModal.tsx': 5,
  'ui/components/modals/groups/GroupMemberSheetModal.tsx': 4,
  'ui/components/modals/groups/GroupRecentlyDeletedModal.tsx': 5,
  'ui/screens/OnboardingScreen.tsx': 5,
  'ui/components/ActionSheet.tsx': 4,
  'ui/components/modals/chat/ChatStarredModal.tsx': 4,
  'ui/components/modals/groups/GroupStarredModal.tsx': 4,
  'ui/screens/PrivacyPolicyScreen.tsx': 4,
  'App.tsx': 2,
  'ui/components/SplashOverlay.tsx': 3,
  'ui/components/modals/groups/GroupAdminLogModal.tsx': 3,
  'ui/components/modals/shared/ScheduledListModal.tsx': 3,
  'ui/screens/BackupWarningScreen.tsx': 3,
  'ui/screens/HelpScreen.tsx': 3,
  'ui/screens/LoadingScreen.tsx': 3,
  'ui/screens/PermissionsScreen.tsx': 3,
  'ui/screens/chat-components/ContactCardBubble.tsx': 2,
  'ui/screens/chat-components/DocBubble.tsx': 3,
  'ui/screens/chat-components/GroupPhotoGrid.tsx': 3,
  'ui/screens/chat-components/MediaStrip.tsx': 3,
  'ui/components/VoiceMessage.tsx': 2,
  'ui/components/modals/chat/ChatPinnedListModal.tsx': 2,
  'ui/components/modals/chat/ChatQuickRepliesModal.tsx': 2,
  'ui/components/modals/chat/ChatWallpaperPickerModal.tsx': 2,
  'ui/components/modals/groups/GroupPinnedListModal.tsx': 2,
  'ui/components/modals/groups/GroupQrModal.tsx': 2,
  'ui/components/modals/groups/GroupQuickReactModal.tsx': 2,
  'ui/components/modals/groups/GroupQuickRepliesModal.tsx': 2,
  'ui/components/modals/groups/GroupReactionsMoreModal.tsx': 2,
  'ui/screens/LoginScreen.tsx': 2,
  'ui/screens/chat-components/DmPollBubble.tsx': 2,
  'ui/screens/chat-components/LinkPreview.tsx': 2,
  'ui/screens/chat-components/LiveLocationBubble.tsx': 2,
  'ui/screens/chat-components/text/CollapsibleMessageBlock.tsx': 2,
  'ui/screens/groups-components/text/GrpCollapsibleBlock.tsx': 2,
  'ui/screens/groups-components/text/GrpFormattedText.tsx': 2,
  'ui/AppErrorBoundary.tsx': 1,
  'ui/ThemeContext.tsx': 1,
  'ui/components/BlockedContactsList.tsx': 1,
  'ui/components/LoadingOverlay.tsx': 1,
  'ui/components/MediaViewer.tsx': 1,
  'ui/components/RichText.tsx': 1,
  'ui/components/modals/chat/ChatReactionsModal.tsx': 1,
  'ui/components/modals/chat/ChatReactionsPickerModal.tsx': 1,
  'ui/screens/chat-components/LocationBubble.tsx': 1,
  'ui/screens/chat-components/SendEffectOverlay.tsx': 1,
  'ui/screens/chat-components/ReactionBar.tsx': 1,
  'ui/screens/chat-components/text/FormattedText.tsx': 1,
  'ui/screens/chat-components/text/MessageBlock.tsx': 1,
  'ui/screens/groups-components/text/GrpMessageBlock.tsx': 1,
};

const RADIUS_BASELINE: Record<string, number> = {
  'ui/screens/GroupsScreen.tsx': 9,
  'ui/components/AttachSheet.tsx': 8,
  'ui/screens/ChatScreen.tsx': 6,
  'ui/screens/FeedScreen.tsx': 5,
  'ui/components/LocationMessage.tsx': 3,
  'ui/components/VoiceMessage.tsx': 3,
  'ui/screens/ChatListScreen.tsx': 3,
  'ui/screens/ProfileScreen.tsx': 3,
  'ui/components/StoriesRow.tsx': 2,
  'ui/screens/LoadingScreen.tsx': 2,
  'ui/screens/chat-components/DmPollBubble.tsx': 2,
  'ui/screens/groups-components/PollBubble.tsx': 2,
  'ui/components/ActionSheet.tsx': 1,
  'ui/components/MediaPreviewModal.tsx': 1,
  'ui/screens/chat-components/EmojiPanel.tsx': 1,
  'ui/components/MediaViewer.tsx': 1,
  'ui/components/RelaySettingsSection.tsx': 1,
  'ui/components/SplashOverlay.tsx': 1,
  'ui/components/VpnSettingsSection.tsx': 1,
  'ui/components/modals/chat/ChatQuickReactModal.tsx': 1,
  'ui/components/modals/chat/ChatQuickRepliesModal.tsx': 1,
  'ui/components/modals/chat/ChatReactionsModal.tsx': 1,
  'ui/components/modals/groups/GroupAdminLogModal.tsx': 1,
  'ui/components/modals/groups/GroupCreateModal.tsx': 1,
  'ui/components/modals/groups/GroupJoinRequestsModal.tsx': 1,
  'ui/components/modals/groups/GroupMemberSheetModal.tsx': 1,
  'ui/components/modals/groups/GroupQuickReactModal.tsx': 1,
  'ui/components/modals/groups/GroupQuickRepliesModal.tsx': 1,
  'ui/screens/chat-components/LiveLocationBubble.tsx': 1,
};

describe.each([
  ['кегль', 'fontSize', FONT_SIZE_BASELINE, 'font.xs / font.sm / font.md / font.lg / font.xl / font.xxl'],
  ['скругление', 'borderRadius', RADIUS_BASELINE, 'radius.sm / radius.md / radius.lg / radius.xl / radius.full'],
])('%s, вписанный числом', (_name, prop, baseline, replacement) => {
  const counted = new Map<string, number>();
  for (const file of collect(SRC)) {
    const key = relKey(file);
    // Сама палитра: там эти числа и определяются.
    if (key === 'ui/theme.ts') continue;
    const n = numericValues(readFileSync(file, 'utf8'), prop).length;
    if (n > 0) counted.set(key, n);
  }

  it('ни один файл не заводит новых', () => {
    const grown: string[] = [];
    for (const [key, n] of counted) {
      const allowed = baseline[key] ?? 0;
      if (n > allowed) grown.push(`${key}: ${n} (было ${allowed})`);
    }
    expect(`${grown.join('\n')}${grown.length ? `\n\nВместо числа: ${replacement}` : ''}`).toBe('');
  });

  it('планка опускается вслед за исправлениями', () => {
    const stale: string[] = [];
    for (const [key, allowed] of Object.entries(baseline)) {
      const n = counted.get(key) ?? 0;
      if (n < allowed) stale.push(`${key}: ${n} (в списке ${allowed})`);
    }
    expect(stale.join('\n')).toBe('');
  });
});
