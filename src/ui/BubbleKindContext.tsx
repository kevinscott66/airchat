/**
 * Какого рода пузыри рисует поддерево — личная переписка или группа.
 *
 * v4.32.413: заливка своего пузыря у этих двух экранов разная (`bubbleOut` в
 * переписке, `primary` в группе), а компоненты, которыми они делятся —
 * `DocBubble`, `ContactCardBubble`, `VoicePlayer`, `GifBubble`, `LinkPreview` —
 * считали чернила всегда по переписке. В тёмной теме свой пузырь группы
 * (#3d5afe) получал чернила, подобранные под #1a2e5e: вторичный текст (имя
 * файла, размер, домен ссылки) давал 2.05:1 при пороге 4.5, приглушённый —
 * 1.20:1 при пороге 3.
 *
 * Признак сделан контекстом, а не пропом, намеренно: проп пришлось бы
 * прокидывать в пяти местах и ровно там его и забыли бы снова. Провайдер стоит
 * один раз на экране групп, значение по умолчанию — переписка.
 */
import React, { createContext, useContext, useMemo } from 'react';
import { useTheme } from './ThemeContext';
import { bubbleSurface, type BubbleKind, type BubbleSurface } from './theme';

const BubbleKindContext = createContext<BubbleKind>('chat');

export function BubbleKindProvider({ kind, children }: { kind: BubbleKind; children: React.ReactNode }): React.ReactElement {
  return <BubbleKindContext.Provider value={kind}>{children}</BubbleKindContext.Provider>;
}

export function useBubbleKind(): BubbleKind {
  return useContext(BubbleKindContext);
}

/** Поверхность пузыря текущего экрана: заливка, чернила, вложенная плашка. */
export function useBubbleSurface(mine: boolean): BubbleSurface {
  const { colors } = useTheme();
  const kind = useBubbleKind();
  return useMemo(() => bubbleSurface(colors, mine, kind), [colors, mine, kind]);
}
