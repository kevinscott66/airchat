/**
 * Стили экрана настроек.
 *
 * Вынесены из SettingsScreen отдельным файлом не ради красоты: они не зависят
 * ни от одного состояния экрана — только от палитры и масштаба шрифта — и
 * занимали на месте больше строк, чем любой из подэкранов. Пока они лежали в
 * конце трёхтысячестрочного файла, всякая правка настроек начиналась с
 * прокрутки мимо них.
 */
import { StyleSheet } from 'react-native';

import { contrastingInk, font, mono, radius, scrim, type AppColors } from '../../theme';

export function makeStyles(c: AppColors, sf: (base: number) => number) {
  return StyleSheet.create({
    // Layout
    container: { flex: 1 },
    content: { padding: 16, paddingBottom: 40 },
    h1: { fontSize: sf(22), fontWeight: '700', color: c.text, marginBottom: 16 },
    sectionTitle: { color: c.textSecondary, fontSize: sf(12), fontWeight: '700', marginTop: 20, marginBottom: 8, letterSpacing: 0.5 },
    hint: { color: c.textMuted, fontSize: sf(12), marginBottom: 8, lineHeight: sf(16) },

    // Cards
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 12,
      marginBottom: 8,
    },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
    rowBody: { flex: 1, paddingRight: 8 },
    label: { color: c.text, fontSize: sf(16), fontWeight: '600' },
    desc: { color: c.textMuted, fontSize: sf(12), marginTop: 4, lineHeight: sf(16) },
    // Подложки и цвета надписи здесь нет: они зависят от состояния и
    // считаются парой на месте вызова (v4.32.396).
    badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.md },
    badgeText: { fontSize: sf(12), fontWeight: '600' },

    // Switch rows
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    switchRowLast: { borderBottomWidth: 0 },

    // Link rows
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      padding: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      gap: 10,
      marginBottom: 8,
    },

    /** Напоминание о непроверенной записи слов: кромка цвета предупреждения. */
    seedReminder: { borderColor: c.warning },

    // Press feedback
    pressed: { opacity: 0.7 },

    // Menu card (grouped rows)
    menuCard: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
      marginBottom: 8,
    },
    menuRow: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 14,
      gap: 12,
    },
    menuDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
      marginLeft: 54,
    },
    menuIcon: {
      width: 34,
      height: 34,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // Sub-screen header
    subHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 16,
      paddingTop: 4,
    },
    backBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingVertical: 6,
      paddingRight: 8,
      minWidth: 80,
    },
    backBtnText: { color: c.accent, fontSize: sf(16), fontWeight: '500' },
    subTitle: {
      flex: 1,
      textAlign: 'center',
      color: c.text,
      fontSize: sf(16),
      fontWeight: '700',
      paddingHorizontal: 4,
    },

    // Misc
    listWrap: { flex: 1, minHeight: 100, marginHorizontal: 16, marginBottom: 8 },
    logoutRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      padding: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      // v4.32.400: было '#4a2a2a' — тёмно-бурый, подобранный под тёмную тему;
      // на белой карточке светлой темы это просто грязная рамка мимо палитры.
      borderColor: c.error,
      gap: 10,
    },
    logoutLabel: { color: c.error, fontSize: sf(16), fontWeight: '600' },
    versionTap: { alignSelf: 'center', marginTop: 20, paddingVertical: 6, paddingHorizontal: 10 },
    versionText: { color: c.textMuted, fontSize: sf(font.xs), textAlign: 'center' },

    // Theme / appearance
    themeRow: { flexDirection: 'row', gap: 8, paddingTop: 10, paddingBottom: 12 },
    themeBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
      paddingVertical: 9, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceHigh,
    },
    themeBtnActive: { backgroundColor: c.primary, borderColor: c.primary },
    themeBtnText: { color: c.textSecondary, fontSize: sf(12), fontWeight: '500' },
    // Выбор кегля (v4.32.594). Две вещи, из-за которых «Очень крупный» и его
    // «А» вылезали за плашку, и обе исправлены здесь, а не подрезкой строки:
    //
    // 1. Кнопки стояли строкой — «А» и подпись бок о бок. На четверть ширины
    //    экрана этого хватало только самой короткой подписи. Теперь колонка:
    //    образец сверху, слово под ним, и на слово работает вся ширина кнопки.
    // 2. Подпись масштабировалась выбранным кеглем — то есть на «Очень
    //    крупном» разрасталась ровно та надпись, которая этот выбор называет.
    //    Орган управления не меняет собственный размер от того, чем управляет:
    //    подписи здесь — font.xs без множителя, как деления на линейке.
    //
    // Две строки разрешены намеренно: подпись переносится, а не обрезается —
    // «Очень кру…» не называет размер.
    fontBtn: { flexDirection: 'column', gap: 3, flex: 1, minWidth: 0, paddingHorizontal: 4 },
    fontBtnSample: { fontWeight: '700' },
    fontBtnLabel: { color: c.textSecondary, fontSize: font.xs, fontWeight: '500', textAlign: 'center' },
    themeBtnTextActive: { color: contrastingInk(c.primary), fontWeight: '700' },
    hourBtn: { padding: 8, borderRadius: radius.md, backgroundColor: c.surfaceHigh },

    // Modals
    pwdModalKav: { flex: 1, justifyContent: 'center' },
    pwdModalBg: { flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', padding: 20 },
    pwdModalBox: { backgroundColor: c.surface, borderRadius: radius.lg, padding: 16, borderWidth: 1, borderColor: c.border },
    pwdInput: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: 12, fontSize: sf(16), color: c.text, marginBottom: 10 },
    pwdPrimaryBtn: { backgroundColor: c.primary, padding: 14, borderRadius: radius.md, alignItems: 'center', marginTop: 8 },
    pwdPrimaryBtnText: { color: contrastingInk(c.primary), fontSize: sf(16), fontWeight: '600' },
    pwdCancel: { color: c.accent, textAlign: 'center', marginTop: 14, fontSize: sf(16) },
    modalTitle: { fontSize: sf(18), fontWeight: '700', color: c.text, marginBottom: 8 },

    // Seed
    seedBox: { backgroundColor: c.surfaceHigh, borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: c.border },
    seedText: { color: c.text, fontSize: sf(15), lineHeight: sf(24), fontFamily: mono },
  });
}
