import React from 'react';
type ReactTestRenderer = { update: (node: React.ReactElement) => void; unmount: () => void };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { act, create } = require('react-test-renderer') as {
  act: (work: () => void) => void;
  create: (node: React.ReactElement) => ReactTestRenderer;
};
import { useChatBottomAnchor } from '../useChatBottomAnchor';

it('follows committed incoming layout only at bottom and preserves readers/search', () => {
  jest.useFakeTimers();
  const oldRequest = global.requestAnimationFrame;
  const oldCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 16) as unknown as number;
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  const scroll = jest.fn();
  const list = { current: { scrollToOffset: scroll } };
  const awayRef = { current: false };
  let result: ReturnType<typeof useChatBottomAnchor>;
  let tree: ReactTestRenderer;
  function Test({ away = false, enabled = true }) {
    result = useChatBottomAnchor(list, away, awayRef, enabled);
    return null;
  }
  try {
    act(() => { tree = create(<Test />); });
    expect(result!.maintainVisibleContentPosition.disabled).toBe(true);
    act(() => { result.onContentSizeChange(); });
    expect(scroll).not.toHaveBeenCalled();
    act(() => { jest.runAllTimers(); });
    expect(scroll).toHaveBeenLastCalledWith({ offset: 0, animated: false });
    scroll.mockClear();
    awayRef.current = true;
    act(() => { tree.update(<Test away />); result.onContentSizeChange(); jest.runAllTimers(); });
    expect(result!.maintainVisibleContentPosition.disabled).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
    awayRef.current = false;
    act(() => { tree.update(<Test />); });
    act(() => { result.onContentSizeChange(); });
    awayRef.current = true; // user scrolls before queued frame
    act(() => { jest.runAllTimers(); });
    expect(scroll).not.toHaveBeenCalled();
    awayRef.current = false;
    act(() => { tree.update(<Test enabled={false} />); });
    act(() => { result.onContentSizeChange(); jest.runAllTimers(); });
    expect(scroll).not.toHaveBeenCalled();
    act(() => { tree.update(<Test />); });
    act(() => { result.onContentSizeChange(); });
    act(() => { tree.unmount(); });
    act(() => { jest.runAllTimers(); });
    expect(scroll).not.toHaveBeenCalled();
  } finally {
    global.requestAnimationFrame = oldRequest;
    global.cancelAnimationFrame = oldCancel;
    jest.useRealTimers();
  }
});
