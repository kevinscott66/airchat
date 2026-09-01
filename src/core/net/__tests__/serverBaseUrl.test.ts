/**
 * Адрес сервера из недоверенного источника.
 *
 * Проверка того же правила, что раньше жило внутри parseRelayInput, но теперь
 * применяется ко всякому серверу в конфиге. Разбор здесь важнее обычного: его
 * результат подставляется в шаблон запроса, и всё, что он пропустит, уедет в
 * сеть как есть.
 */

import { parseServerBase, normalizeServerBase } from '../serverBaseUrl';

const ok = (raw: unknown) => {
  const r = parseServerBase(raw);
  if (!r.ok) throw new Error(`ожидался разбор, получено: ${r.error}`);
  return r.base;
};

describe('parseServerBase', () => {
  it('схему можно не писать — подставляется https', () => {
    expect(ok('ntfy.example.com')).toEqual({
      httpBase: 'https://ntfy.example.com',
      wsBase: 'wss://ntfy.example.com',
      insecure: false,
    });
  });

  it('ws-схема приводится к http, потому что по этому же адресу ходит fetch', () => {
    // Ровно та поломка, из-за которой звонки работали, а регистрация
    // пуш-токена молча нет: socket.io принимает wss://, fetch — нет.
    expect(ok('wss://sig.example.com').httpBase).toBe('https://sig.example.com');
    expect(ok('ws://sig.example.com').httpBase).toBe('http://sig.example.com');
    expect(ok('ws://sig.example.com').insecure).toBe(true);
  });

  it('хвостовые слэши снимаются — иначе `${base}/${topic}` даёт двойной', () => {
    expect(ok('https://ntfy.example.com/').httpBase).toBe('https://ntfy.example.com');
    expect(ok('https://ntfy.example.com///').httpBase).toBe('https://ntfy.example.com');
    expect(ok('https://ntfy.example.com/ntfy/').httpBase).toBe('https://ntfy.example.com/ntfy');
  });

  it('путь сохраняется: ntfy за прокси часто живёт не в корне', () => {
    expect(ok('https://example.com/ntfy')).toEqual({
      httpBase: 'https://example.com/ntfy',
      wsBase: 'wss://example.com/ntfy',
      insecure: false,
    });
  });

  it('порт сохраняется, хост приводится к нижнему регистру', () => {
    expect(ok('HTTPS://Ntfy.Example.COM:8443').httpBase).toBe('https://ntfy.example.com:8443');
  });

  it('пробелы по краям срезаются, внутри — отказ', () => {
    expect(ok('  https://ntfy.example.com  ').httpBase).toBe('https://ntfy.example.com');
    expect(parseServerBase('https://ntfy example.com').ok).toBe(false);
  });

  it('пусто и не строка — отказ с текстом для человека', () => {
    for (const v of ['', '   ', null, undefined, 42, {}, []]) {
      const r = parseServerBase(v);
      expect([JSON.stringify(v), r.ok]).toEqual([JSON.stringify(v), false]);
      expect(r.ok ? '' : r.error.length).toBeGreaterThan(0);
    }
  });

  it('чужие схемы не проходят — включая те, что ломают fetch молча', () => {
    for (const v of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x', 'ftp://example.com']) {
      expect([v, parseServerBase(v).ok]).toEqual([v, false]);
    }
  });

  it('логин с паролем в адресе — отказ', () => {
    expect(parseServerBase('https://user:pass@example.com').ok).toBe(false);
    expect(parseServerBase('https://user@example.com').ok).toBe(false);
  });

  it('«?» и «#» — отказ: к адресу дописывается тема, а не параметры', () => {
    expect(parseServerBase('https://example.com/?a=1').ok).toBe(false);
    expect(parseServerBase('https://example.com/#x').ok).toBe(false);
  });

  it('имя без домена — отказ, localhost и IP — нет', () => {
    // «myserver» не разрешится ни в одной сети; localhost на телефоне
    // указывает на сам телефон, но для отладки это законный адрес.
    expect(parseServerBase('myserver').ok).toBe(false);
    expect(ok('http://localhost:2586').httpBase).toBe('http://localhost:2586');
    expect(ok('153.76.207.210').httpBase).toBe('https://153.76.207.210');
    expect(ok('http://[::1]:2586').httpBase).toBe('http://[::1]:2586');
  });

  it('http помечается как insecure, https — нет', () => {
    expect(ok('http://example.com').insecure).toBe(true);
    expect(ok('https://example.com').insecure).toBe(false);
  });

  it('разбор идемпотентен: свой же результат разбирается в себя', () => {
    // Иначе повторное сохранение настроек меняло бы адрес.
    for (const v of ['ntfy.example.com', 'https://example.com/ntfy/', 'wss://example.com:8443', 'http://localhost:2586']) {
      const once = ok(v);
      expect([v, ok(once.httpBase)]).toEqual([v, once]);
      expect([v, ok(once.wsBase)]).toEqual([v, once]);
    }
  });
});

describe('normalizeServerBase', () => {
  it('годное значение — пара адресов, негодное — null', () => {
    expect(normalizeServerBase('example.com')?.httpBase).toBe('https://example.com');
    // Пустая строка — самая опасная из негодных: `?? DEFAULT` её пропускает,
    // и запрос уходит на относительный '/<тема>'.
    expect(normalizeServerBase('')).toBeNull();
    expect(normalizeServerBase(undefined)).toBeNull();
    expect(normalizeServerBase('javascript:alert(1)')).toBeNull();
  });
});
