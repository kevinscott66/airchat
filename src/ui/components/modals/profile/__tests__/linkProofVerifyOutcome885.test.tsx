/**
 * v4.32.885 — «Проверяем…» гасло, и окно замолкало.
 *
 * Дефект. У `verify` в LinkProofSheet стоял `try … finally` без `catch`.
 * Отказ площадки сама проверка возвращает ответом ('network'), но упасть
 * броском на этом пути есть чему: обращение к площадке и разбор подписи идут
 * через чужой код, а привязка завершается вызовом наружу (`onLinked`,
 * `onClose`) — это обработчики владельца экрана. Любое исключение оттуда
 * проходило мимо: `finally` снимал «Проверяем…», и на этом всё кончалось.
 *
 * Цена. Кнопка возвращается в исходное состояние, будто её и не нажимали:
 * ни галочки, ни ошибки, ни подсказки «сохранить без подтверждения». Человек
 * жмёт «Проверить» ещё раз — и получает ровно то же самое. Причина не
 * попадала и в журнал, так что разбираться потом было не по чему. Экран, где
 * доказывают владение именем, молчать не вправе: молчание здесь читается как
 * «не сходится».
 *
 * Правка. Ловец на месте: отказ называется по-русски (свой текст исключения
 * сохраняется, если он есть), причина уходит в журнал, `finally` по-прежнему
 * снимает занятость.
 */
import React, { act } from 'react';

// react-test-renderer приходит с jest-expo; деклараций типов в проекте нет.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => {
    root: {
      findByProps: (p: Record<string, unknown>) => {
        props: Record<string, unknown>;
      };
      findAllByProps: (p: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
    unmount: () => void;
  };
};

// Жесты в этой проверке ни при чём, а их нативный модуль в jest не живёт:
// AppModal оборачивает содержимое в GestureHandlerRootView.
jest.mock('react-native-gesture-handler', () => {
  const RN = jest.requireActual('react-native');
  return { GestureHandlerRootView: RN.View };
});

// Отступов безопасной зоны в jest нет: их провайдер живёт над всем деревом
// приложения, а здесь поднят один лист.
jest.mock('react-native-safe-area-context', () => {
  const RN = jest.requireActual('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaProvider: RN.View,
    SafeAreaView: RN.View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets },
  };
});

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

const mockCheck = jest.fn();
jest.mock('../../../../../core/identity/linkProofCheck', () => ({
  checkLinkProof: (...a: unknown[]) => mockCheck(...a),
}));

jest.mock('../../../../../core/crypto/keyManager', () => ({
  loadKeyPair: jest.fn(async () => ({ secretKey: new Uint8Array(64), publicKey: new Uint8Array(32) })),
}));
jest.mock('../../../../../core/crypto/signature', () => ({
  signBytes: jest.fn(async () => new Uint8Array(64).fill(3)),
}));
jest.mock('../../../../../core/identity/accountRef', () => ({
  ownAccountRef: () => 'did:key:zTest',
}));

const mockWarn = jest.fn();
jest.mock('../../../../../core/logger', () => ({
  log: { info: jest.fn(), warn: (m: string, meta?: unknown) => mockWarn(m, meta), debug: jest.fn(), error: jest.fn() },
}));

import { LinkProofSheet } from '../LinkProofSheet';

type Tree = ReturnType<typeof TestRenderer.create>;

/** Нажать по testID так, как это делает человек. */
async function press(tree: Tree, testID: string): Promise<void> {
  const el = tree.root.findByProps({ testID });
  await act(async () => {
    (el.props.onPress as () => void)();
  });
}

/** Текст внутри узла — строки лежат в children как есть. */
function textOf(node: { props: Record<string, unknown> }): string {
  const kids = node.props.children;
  return Array.isArray(kids) ? kids.filter((k) => typeof k === 'string').join('') : String(kids ?? '');
}

/** Довести лист до шага «вставьте адрес публикации». */
async function openAtVerifyStep(onLinked = jest.fn(), onClose = jest.fn()): Promise<Tree> {
  let tree: Tree | null = null;
  await act(async () => {
    tree = TestRenderer.create(
      <LinkProofSheet
        visible
        platform="github"
        publicKeyB64={KEY_B64}
        initialHandle="octocat"
        linked={false}
        onClose={onClose}
        onLinked={onLinked}
        onUnlinked={jest.fn()}
      />,
    );
  });
  const t = tree as unknown as Tree;
  await press(t, 'link_proof_issue');
  await act(async () => {
    (t.root.findByProps({ testID: 'link_proof_url' }).props.onChangeText as (v: string) => void)(
      'https://gist.github.com/octocat/abc123',
    );
  });
  return t;
}

beforeEach(() => {
  mockCheck.mockReset();
  mockWarn.mockClear();
});

describe('v4.32.885 — проверка привязки отвечает за себя', () => {
  describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
    it('лист доходит до шага проверки и кнопка на месте', async () => {
      const t = await openAtVerifyStep();
      expect(textOf(t.root.findByProps({ testID: 'link_proof_verify' }))).not.toBe('');
      t.unmount();
    });

    it('обычное «не сходится» показывают и без правки', async () => {
      mockCheck.mockResolvedValue({ ok: false, reason: 'owner_mismatch' });
      const t = await openAtVerifyStep();
      await press(t, 'link_proof_verify');
      expect(textOf(t.root.findByProps({ testID: 'link_proof_error' })).length).toBeGreaterThan(5);
      t.unmount();
    });

    it('удачная проверка по-прежнему привязывает и закрывает', async () => {
      const onLinked = jest.fn();
      const onClose = jest.fn();
      mockCheck.mockResolvedValue({ ok: true, payload: {} });
      const t = await openAtVerifyStep(onLinked, onClose);
      await press(t, 'link_proof_verify');
      expect(onLinked).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
      t.unmount();
    });
  });

  describe('бросок больше не уносит ответ', () => {
    it('проверка упала — человек видит русский текст, а не пустой лист', async () => {
      mockCheck.mockRejectedValue(new Error('Network request failed'));
      const t = await openAtVerifyStep();
      await press(t, 'link_proof_verify');
      const said = textOf(t.root.findByProps({ testID: 'link_proof_error' }));
      expect(said).toMatch(/[А-Яа-яЁё]/);
      expect(said).not.toContain('Network request failed');
      t.unmount();
    });

    it('свой русский текст исключения сохраняется', async () => {
      mockCheck.mockRejectedValue(new Error('Ключ аккаунта недоступен'));
      const t = await openAtVerifyStep();
      await press(t, 'link_proof_verify');
      expect(textOf(t.root.findByProps({ testID: 'link_proof_error' }))).toBe('Ключ аккаунта недоступен');
      t.unmount();
    });

    it('причина уходит в журнал', async () => {
      mockCheck.mockRejectedValue(new Error('boom'));
      const t = await openAtVerifyStep();
      await press(t, 'link_proof_verify');
      expect(mockWarn).toHaveBeenCalledWith('link_proof_verify_failed', expect.anything());
      t.unmount();
    });

    it('отказ обработчика привязки тоже не пропадает', async () => {
      mockCheck.mockResolvedValue({ ok: true, payload: {} });
      const onLinked = jest.fn(() => {
        throw new Error('Не удалось сохранить привязку');
      });
      const t = await openAtVerifyStep(onLinked);
      await press(t, 'link_proof_verify');
      expect(textOf(t.root.findByProps({ testID: 'link_proof_error' }))).toBe('Не удалось сохранить привязку');
      t.unmount();
    });
  });
});
