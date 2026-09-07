/**
 * Регистрация на сигнальном сервере жива, пока жива служба (v4.32.615).
 *
 * Приём входящего звонка держится на одной вещи — на том, что сервер знает
 * этот телефон. Повтор регистрации завёлся в v4.32.587, но заводился он
 * только если не удалась ПЕРВАЯ попытка, и снимался с первым же успехом.
 * Дальше регистрацию держал транспорт: socket.io сам переподключается и зовёт
 * перерегистрацию. Делает он её ровно один раз, и её неудача — истёкшее
 * ожидание вызова, отказ сервера — только пишется в журнал. Сокет остаётся
 * живым, второго `connect` не будет, повторить нечем. Телефон снова невидим
 * для звонящих до перезапуска приложения.
 *
 * Второе следствие того же места: экран диагностики отвечал по памяти о
 * прошлом успехе. «Зарегистрирован — входящие звонки дойдут» показывалось
 * телефону, которого сервер уже не видит, — то есть ровно в том случае, ради
 * которого экран и открывают.
 */
import fs from 'fs';
import path from 'path';

let mockRegistered = false;
const mockRegister = jest.fn();
const mockConnect = jest.fn();

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    connect = async (): Promise<void> => { mockConnect(); };
    register = async (...a: unknown[]): Promise<void> => {
      mockRegister(...a);
      mockRegistered = true;
    };
    isRegistered = (): boolean => mockRegistered;
    disconnect = (): void => { mockRegistered = false; };
    sendAnswer = jest.fn();
    sendOffer = jest.fn();
    sendIceCandidate = jest.fn();
    onOffer = jest.fn();
    onAnswer = jest.fn();
    onIceCandidate = jest.fn();
    onPeerUnavailable = jest.fn();
    onMissedCalls = jest.fn();
  },
}));

jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => ({ webrtc: { signalingUrl: 'http://signal.test' } })),
}));

jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async (): Promise<void> => undefined,
    isBlocked: (): boolean => false,
  },
}));

import { disposeCallService, getCallServiceStatus, initCallService } from '../callService';
import { makePeer } from './callTestPeers';

const me = makePeer();

beforeEach(async () => {
  mockRegistered = false;
  mockRegister.mockClear();
  mockConnect.mockClear();
  await disposeCallService();
});

afterEach(async () => {
  await disposeCallService();
});

describe('состояние регистрации', () => {
  it('после успешной регистрации телефон виден', async () => {
    await initCallService(me.pair);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(getCallServiceStatus()).toMatchObject({ hasKey: true, registered: true });
  });

  it('потерянная регистрация показывается потерянной, а не помнится успешной', async () => {
    await initCallService(me.pair);
    expect(getCallServiceStatus().registered).toBe(true);
    // Обрыв и неудачная перерегистрация внутри транспорта: сокет жив, но
    // сервер про этот телефон уже не знает.
    mockRegistered = false;
    expect(getCallServiceStatus().registered).toBe(false);
    expect(getCallServiceStatus().retrying).toBe(true);
  });

  it('сторож заведён и после удачной первой попытки', async () => {
    await initCallService(me.pair);
    expect(getCallServiceStatus().retrying).toBe(true);
  });

  it('после остановки службы сторожа нет', async () => {
    await initCallService(me.pair);
    await disposeCallService();
    expect(getCallServiceStatus()).toMatchObject({ hasKey: false, registered: false, retrying: false });
  });
});

describe('форма кода', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'callService.ts'), 'utf8');
  const CODE = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('сторож не снимается по первому успеху', () => {
    const init = CODE.slice(
      CODE.indexOf('export async function initCallService'),
      CODE.indexOf('function isSignalingLive')
    );
    expect(init).not.toBe('');
    // Единственное снятие внутри тика — по смене эпохи или ключа, а не по
    // поднятому признаку регистрации.
    expect(init).not.toContain('|| signalingRegistered');
    expect(init).toContain('if (isSignalingLive()) return;');
  });

  it('живость спрашивается у транспорта, а не у своей памяти', () => {
    const fn = CODE.slice(CODE.indexOf('function isSignalingLive'), CODE.indexOf('export function getCallServiceStatus'));
    expect(fn).not.toBe('');
    expect(fn).toContain('sig.isRegistered()');
  });

  it('экран диагностики отвечает живым состоянием', () => {
    const fn = CODE.slice(CODE.indexOf('export function getCallServiceStatus'), CODE.indexOf('export async function disposeCallService'));
    expect(fn).not.toBe('');
    expect(fn).toContain('registered: isSignalingLive(),');
    expect(fn).not.toContain('registered: signalingRegistered,');
  });
});
