/**
 * Разбор адреса своего сервера-ретранслятора (v4.32.330).
 *
 * Проверяется результат разбора, а не внутренние шаги: на вход идёт то, что
 * человек реально впишет в поле, на выходе — пара адресов, которую получит
 * транспорт, либо понятная причина отказа.
 */
import {
  DEFAULT_RELAY_BASE,
  DEFAULT_WS_BASE,
  isCustomRelay,
  parseRelayInput,
} from '../relayConfig';

/** Короткая обёртка: успешный разбор или проваленный тест с текстом ошибки. */
function ok(raw: string) {
  const r = parseRelayInput(raw);
  if (!r.ok) throw new Error(`ожидался успех, получено: ${r.error}`);
  return r;
}

function err(raw: string): string {
  const r = parseRelayInput(raw);
  if (r.ok) throw new Error(`ожидался отказ, получено: ${r.endpoints.relayBase}`);
  return r.error;
}

describe('parseRelayInput — адрес сервера', () => {
  it('добавляет https, когда схему не написали', () => {
    expect(ok('ntfy.example.com').endpoints).toEqual({
      relayBase: 'https://ntfy.example.com',
      wsBase: 'wss://ntfy.example.com',
    });
  });

  it('оставляет явный https и выводит wss', () => {
    expect(ok('https://relay.example.org').endpoints).toEqual({
      relayBase: 'https://relay.example.org',
      wsBase: 'wss://relay.example.org',
    });
  });

  it('принимает wss:// — за обратным прокси человек видит именно его', () => {
    expect(ok('wss://relay.example.org').endpoints).toEqual({
      relayBase: 'https://relay.example.org',
      wsBase: 'wss://relay.example.org',
    });
  });

  it('ws:// понимается как http', () => {
    const r = ok('ws://10.0.0.5:8080');
    expect(r.endpoints).toEqual({ relayBase: 'http://10.0.0.5:8080', wsBase: 'ws://10.0.0.5:8080' });
  });

  it('сохраняет порт', () => {
    expect(ok('https://example.com:8443').endpoints.relayBase).toBe('https://example.com:8443');
  });

  it('сохраняет путь: за прокси ntfy часто живёт не в корне', () => {
    expect(ok('https://example.com/ntfy').endpoints).toEqual({
      relayBase: 'https://example.com/ntfy',
      wsBase: 'wss://example.com/ntfy',
    });
  });

  it('снимает хвостовые слэши — иначе к теме приклеится двойной', () => {
    expect(ok('https://example.com/ntfy//').endpoints.relayBase).toBe('https://example.com/ntfy');
    expect(ok('https://example.com/').endpoints.relayBase).toBe('https://example.com');
  });

  it('обрезает пробелы по краям и приводит хост к нижнему регистру', () => {
    expect(ok('  HTTPS://Ntfy.Example.COM  ').endpoints.relayBase).toBe('https://ntfy.example.com');
  });

  it('предупреждает про http, но не отказывает', () => {
    const r = ok('http://192.168.1.50:8080');
    expect(r.warning).toContain('https');
    expect(r.endpoints.wsBase).toBe('ws://192.168.1.50:8080');
  });

  it('на https предупреждения нет', () => {
    expect(ok('https://example.com').warning).toBeUndefined();
  });

  it('пустое поле — отдельная понятная ошибка', () => {
    expect(err('')).toBe('Введите адрес сервера');
    expect(err('   ')).toBe('Введите адрес сервера');
  });

  it('пробел внутри адреса — это опечатка, а не адрес', () => {
    expect(err('ntfy example.com')).toContain('пробел');
  });

  it('логин с паролем в адресе отклоняется', () => {
    expect(err('https://user:pass@example.com')).toContain('Логин');
  });

  it('чужие схемы отклоняются', () => {
    expect(err('ftp://example.com')).toContain('https://');
    expect(err('javascript://example.com')).toContain('https://');
    expect(err('file:///etc/hosts')).toContain('https://');
  });

  it('«?» и «#» в адресе отклоняются: тема дописывается в конец', () => {
    expect(err('https://example.com/?a=1')).toContain('«?»');
    expect(err('https://example.com/#x')).toContain('«?»');
  });

  it('имя без домена отклоняется — оно не разрешится ни в одной сети', () => {
    expect(err('myserver')).toContain('полное имя');
  });

  it('localhost разрешён: им пользуются при отладке через adb reverse', () => {
    expect(ok('http://localhost:2586').endpoints.relayBase).toBe('http://localhost:2586');
  });

  it('нестрока не роняет разбор', () => {
    expect(parseRelayInput(undefined as unknown as string)).toEqual({
      ok: false,
      error: 'Введите адрес сервера',
    });
  });

  it('значения по умолчанию проходят разбор без изменений', () => {
    expect(ok(DEFAULT_RELAY_BASE).endpoints).toEqual({
      relayBase: DEFAULT_RELAY_BASE,
      wsBase: DEFAULT_WS_BASE,
    });
  });
});

describe('isCustomRelay', () => {
  it('ntfy.sh и пустое значение — это «по умолчанию»', () => {
    expect(isCustomRelay(DEFAULT_RELAY_BASE)).toBe(false);
    expect(isCustomRelay(undefined)).toBe(false);
    expect(isCustomRelay('')).toBe(false);
  });

  it('любой другой адрес — свой сервер', () => {
    expect(isCustomRelay('https://ntfy.example.com')).toBe(true);
  });
});
