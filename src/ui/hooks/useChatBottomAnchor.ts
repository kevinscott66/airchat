import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';

type ScrollTarget = { scrollToOffset: (options: { offset: number; animated: boolean }) => void };

/** Inverted chats: offset zero is newest. Follow layout, never the earlier DB promise. */
export function useChatBottomAnchor(
  list: RefObject<ScrollTarget | null>,
  awayFromBottom: boolean,
  awayRef: RefObject<boolean>,
  enabled = true,
) {
  const frame = useRef<number | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (!enabledRef.current || awayRef.current) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      // A person may scroll into history between layout and this frame.
      if (enabledRef.current && !awayRef.current) {
        list.current?.scrollToOffset({ offset: 0, animated: false });
      }
    });
  }, [list, awayRef]);
  const maintainVisibleContentPosition = useMemo(() => ({
    // Preserving the old newest row hides newly prepended messages below it.
    // Keep that preservation only when the person is reading older messages.
    disabled: enabled && !awayFromBottom,
  }), [enabled, awayFromBottom]);
  return {
    onContentSizeChange,
    // Resizing a browser panel changes the viewport without necessarily changing
    // message heights. Re-anchor that case too; history readers still stay put.
    onLayout: onContentSizeChange,
    maintainVisibleContentPosition,
  };
}
