/**
 * Первый кадр уходил в сеть, не дождавшись «Автозагрузки медиа» (v4.32.1063).
 *
 * ДЕФЕКТ. `useAutoDownloadGate` начинал с `useState(false)` — то есть с
 * ответа «качать можно», — а настоящий ответ мог прийти только изнутри
 * асинхронного эффекта, уже ПОСЛЕ первой отрисовки. v4.32.1027 научила хук
 * различать три исхода чтения, но ни один из них не успевал к первому кадру.
 *
 * ЦЕНА. В первом кадре запрос уже уходит, и уходит необратимо. У обычного CID
 * `initialSlot` (useResolvedMediaUrls) собирает адрес шлюза синхронно и отдаёт
 * `phase: 'ready'` — `<Image>` монтируется тем же коммитом; пузырь GIF тем же
 * кадром идёт на Tenor (это Google). Перерисовка, приходящая следом, рисует
 * поверх ушедшего запроса «нажмите, чтобы загрузить»: человек, выбравший
 * «Никогда», видел на экране подтверждение, что запрет работает, ровно в тот
 * момент, когда чужой сервер уже получил его IP-адрес и время открытия
 * переписки. Поднять это может любой собеседник — достаточно прислать GIF.
 *
 * ПРАВКА. У хука три ответа: `unknown` — «ещё читаем», и пузырь придержан.
 * Заглушкой «нажмите, чтобы загрузить» это время не называется: запрета никто
 * не высказывал, у большинства выбрано «всегда». Пузырь рисует ожидание, и
 * нажатие на него грузит, как и раньше.
 *
 * ГРАНИЦЫ. Разбор самой настройки не меняется: нет записи — «всегда»,
 * незнакомое значение — «всегда», отказ базы и отказ `NetInfo` — придержать
 * (v4.32.1027).
 */
import React, { act } from 'react';

// react-test-renderer приходит с jest-expo; деклараций типов в проекте нет.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => { unmount: () => void };
};

/** Что лежит в записи; `null` — записи нет. */
let mockValue: string | null = null;
/** Чтение отказывает: `kvTryGet` отвечает `null`. */
let mockReadFails = false;
/** Чтение бросает — путь, которого у `kvTryGet` сейчас нет. */
let mockReadThrows = false;

jest.mock('../../../../core/storage/local', () => ({
  kvTryGet: jest.fn(async () => {
    if (mockReadThrows) throw new Error('kv_exploded');
    return mockReadFails ? null : { value: mockValue };
  }),
  kvGet: jest.fn(async () => (mockReadFails ? null : mockValue)),
}));

/** Тип сети для `NetInfo.fetch()`; `null` — вызов бросает. */
let mockNetType: string | null = 'wifi';

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => {
      if (mockNetType === null) throw new Error('netinfo_unavailable');
      return { type: mockNetType };
    }),
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { useAutoDownloadGate } from '../useAutoDownloadGate';
import { useResolvedMediaSlots, type MediaResolveSlot } from '../useResolvedMediaUrls';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** Только код: докблок не должен сам удовлетворять закрепку. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const STRIP = (): string => codeOnly(read('src/ui/screens/chat-components/MediaStrip.tsx'));
const GRID = (): string => codeOnly(read('src/ui/screens/chat-components/GroupPhotoGrid.tsx'));
const PICKER = (): string => codeOnly(read('src/ui/components/GifPicker.tsx'));
const SLOTS = (): string => codeOnly(read('src/ui/screens/chat-components/useResolvedMediaUrls.ts'));

/** Ответ хука на КАЖДОЙ отрисовке, по порядку. */
let seen: unknown[] = [];

function Harness(): null {
  seen.push(useAutoDownloadGate());
  return null;
}

let mounted: Array<{ unmount: () => void }> = [];

/** Поднять хук и остановиться на первом кадре: чтение ещё не осело. */
function mountOnly(): void {
  let tree!: { unmount: () => void };
  act(() => {
    tree = TestRenderer.create(<Harness />);
  });
  mounted.push(tree);
}

/** Поднять хук и дождаться, пока чтение осядет. */
async function settle(): Promise<void> {
  await act(async () => {
    /* ждём микрозадачи чтения */
  });
}

afterEach(async () => {
  const trees = mounted;
  mounted = [];
  await act(async () => {
    trees.forEach((t) => t.unmount());
  });
});

beforeEach(() => {
  mockValue = null;
  mockReadFails = false;
  mockReadThrows = false;
  mockNetType = 'wifi';
  seen = [];
});

describe('первый кадр не отвечает «качать можно»', () => {
  it('до ответа хранилища хук говорит «ещё не знаем»', () => {
    // Прежде здесь стоял `false` — тот самый ответ, по которому пузырь
    // монтировал <Image> и запрос уходил. Он же приходил и тем, кто выбрал
    // «Никогда»: разобрать настройку успевали только к следующему кадру.
    mockValue = 'never';

    mountOnly();

    expect(seen[0]).toBe('unknown');
  });

  it('«никогда»: сначала ожидание, и только потом запрет', async () => {
    mockValue = 'never';

    mountOnly();
    await settle();

    expect(seen[0]).toBe('unknown');
    expect(seen[seen.length - 1]).toBe('closed');
    expect(seen).not.toContain('open');
  });

  it('база не ответила: «качать можно» не звучит ни на одном кадре', async () => {
    mockReadFails = true;

    mountOnly();
    await settle();

    expect(seen[seen.length - 1]).toBe('closed');
    expect(seen).not.toContain('open');
  });

  it('режим Wi-Fi на мобильном: пока сеть не назвалась, ворота закрыты', async () => {
    mockValue = 'wifi';
    mockNetType = 'cellular';

    mountOnly();
    await settle();

    expect(seen[0]).toBe('unknown');
    expect(seen[seen.length - 1]).toBe('closed');
    expect(seen).not.toContain('open');
  });

  it('чтение бросило — ожидание кончается запретом, а не остаётся навсегда', async () => {
    // `kvTryGet` сейчас не бросает, но `unknown` теперь видно на экране:
    // путь, на котором ответ не придёт никогда, оставил бы человека с
    // вечным индикатором вместо снимка.
    mockReadThrows = true;

    mountOnly();
    await settle();

    expect(seen[seen.length - 1]).toBe('closed');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: открытый первый кадр и правда уходит в сеть', () => {
  it('обычный CID собирается в адрес шлюза синхронно, на первой же отрисовке', () => {
    // Здесь вся цена дефекта: между «ворота открыты» и «запрос ушёл» нет ни
    // одного кадра, на котором можно передумать. Если однажды разбор станет
    // асинхронным целиком, проверка упадёт и потребует пересмотреть
    // постановку, а не подправить ожидание.
    const cid = `Qm${'a'.repeat(44)}`;
    const frames: MediaResolveSlot[][] = [];
    function SlotHarness(): null {
      frames.push(useResolvedMediaSlots([cid], 'https://gw.example').slots);
      return null;
    }
    let tree!: { unmount: () => void };
    act(() => {
      tree = TestRenderer.create(<SlotHarness />);
    });
    mounted.push(tree);

    expect(frames[0]).toEqual([
      { url: `https://gw.example/ipfs/${cid}`, phase: 'ready', reason: null },
    ]);
  });

  it('пустой список на входе разбора — единственный способ никуда не пойти', () => {
    expect(SLOTS()).toContain('function initialSlot(entry: string, gateway: string)');
    for (const [name, src] of Object.entries({ переписка: STRIP(), группа: GRID() })) {
      expect([name, src.includes('holdBack ? [] : entries')]).toEqual([name, true]);
    }
  });
});

describe('«всегда» — ожидание кончается разрешением', () => {
  it('первый кадр ждёт и тех, кто разрешил', async () => {
    // Ожидание платят все, включая большинство с «всегда». Поэтому оно и не
    // называется запретом: пузырь на это время рисует индикатор.
    mockValue = 'always';

    mountOnly();
    await settle();

    expect(seen[0]).toBe('unknown');
    expect(seen[seen.length - 1]).toBe('open');
  });
});

/**
 * Разбор самой настройки правка не трогает, поэтому проверки ниже обязаны
 * проходить и на коде ДО неё — там, где ответ хука был булевым. Отсюда и
 * форма: «ворота в итоге не закрылись», а не «ответ равен такому-то слову».
 * Что именно значит каждое значение настройки, проверяет
 * autoDownloadGateFailOpen1027 — здесь речь только о том, что правка ни у
 * кого ничего не отняла.
 */
describe('ГРАНИЦЫ: у разрешивших ничего не отобрано', () => {
  it('«всегда» — качаем без нажатия', async () => {
    mockValue = 'always';

    mountOnly();
    await settle();

    expect(seen[seen.length - 1]).not.toBe('closed');
  });

  it('записи нет — это первый запуск, а не беда', async () => {
    mockValue = null;

    mountOnly();
    await settle();

    expect(seen[seen.length - 1]).not.toBe('closed');
  });

  it('незнакомое значение по-прежнему читается как «всегда»', async () => {
    mockValue = 'мусор';

    mountOnly();
    await settle();

    expect(seen[seen.length - 1]).not.toBe('closed');
  });

  it('«только Wi-Fi» на Wi-Fi — качаем', async () => {
    mockValue = 'wifi';
    mockNetType = 'wifi';

    mountOnly();
    await settle();

    expect(seen[seen.length - 1]).not.toBe('closed');
  });
});

describe('ЗАКРЕПКА: пузыри придерживаются всем, кроме «можно»', () => {
  it('все три пузыря спрашивают именно «открыто ли», а не «запрещено ли»', () => {
    for (const [name, src] of Object.entries({ переписка: STRIP(), группа: GRID() })) {
      expect([name, src.includes("const holdBack = gated !== 'open' && !wanted;")]).toEqual([
        name,
        true,
      ]);
    }
    expect(PICKER()).toContain("if (gated !== 'open' && !wanted)");
  });

  it('время ожидания не выдаётся за запрет', () => {
    // «нажмите, чтобы загрузить» — это утверждение о человеке: он запретил.
    // Пока его не спросили, на экране должно стоять ожидание.
    for (const [name, src] of Object.entries({
      переписка: STRIP(),
      группа: GRID(),
      GIF: PICKER(),
    })) {
      expect([name, src.includes("gated === 'unknown' ? (")]).toEqual([name, true]);
      expect([name, src.includes('<ActivityIndicator')]).toEqual([name, true]);
    }
  });

  it('нажатие грузит и в ожидании — выход из него есть всегда', () => {
    for (const [name, src] of Object.entries({
      переписка: STRIP(),
      группа: GRID(),
      GIF: PICKER(),
    })) {
      expect([name, src.includes('onPress={() => setWanted(true)}')]).toEqual([name, true]);
    }
  });
});
