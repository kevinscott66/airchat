import {
  InboundSocketRegistry,
  LAN_INBOUND_IDLE_MS,
  LAN_MAX_INBOUND_SOCKETS,
  type ClosableSocket,
} from '../lanInbound';

const NOW = 1_700_000_000_000;

function fakeSocket(): ClosableSocket & { destroyed: number } {
  const s = {
    destroyed: 0,
    destroy(): void {
      s.destroyed += 1;
    },
  };
  return s;
}

describe('InboundSocketRegistry', () => {
  it('считает открытые соединения', () => {
    const r = new InboundSocketRegistry();
    r.add(fakeSocket(), NOW);
    r.add(fakeSocket(), NOW);
    expect(r.size).toBe(2);
  });

  it('закрывает молчащее соединение по сроку, работающее не трогает', () => {
    const r = new InboundSocketRegistry();
    const silent = fakeSocket();
    const busy = fakeSocket();
    const idSilent = r.add(silent, NOW);
    const idBusy = r.add(busy, NOW);
    expect(idSilent).not.toBe(idBusy);

    r.touch(idBusy, NOW + LAN_INBOUND_IDLE_MS);
    expect(r.sweep(NOW + LAN_INBOUND_IDLE_MS + 1)).toBe(1);
    expect(silent.destroyed).toBe(1);
    expect(busy.destroyed).toBe(0);
    expect(r.size).toBe(1);
  });

  it('при переполнении уступает место самое давно молчащее', () => {
    const r = new InboundSocketRegistry();
    const sockets = [];
    for (let i = 0; i < LAN_MAX_INBOUND_SOCKETS; i++) {
      const s = fakeSocket();
      sockets.push(s);
      // Первое соединение самое старое, дальше по возрастанию.
      r.add(s, NOW + i);
    }
    expect(r.size).toBe(LAN_MAX_INBOUND_SOCKETS);

    const fresh = fakeSocket();
    r.add(fresh, NOW + 1000);
    expect(sockets[0].destroyed).toBe(1);
    expect(sockets[1].destroyed).toBe(0);
    expect(fresh.destroyed).toBe(0);
    expect(r.size).toBe(LAN_MAX_INBOUND_SOCKETS);
  });

  it('touch спасает старое соединение от вытеснения', () => {
    const r = new InboundSocketRegistry();
    const ids: number[] = [];
    const sockets = [];
    for (let i = 0; i < LAN_MAX_INBOUND_SOCKETS; i++) {
      const s = fakeSocket();
      sockets.push(s);
      ids.push(r.add(s, NOW + i));
    }
    // По самому старому пошли байты — вытеснить должны следующее за ним.
    r.touch(ids[0], NOW + 5000);
    r.add(fakeSocket(), NOW + 5000);
    expect(sockets[0].destroyed).toBe(0);
    expect(sockets[1].destroyed).toBe(1);
  });

  it('forget снимает с учёта, не закрывая: сокет закрылся сам', () => {
    const r = new InboundSocketRegistry();
    const s = fakeSocket();
    const id = r.add(s, NOW);
    r.forget(id);
    expect(r.size).toBe(0);
    expect(s.destroyed).toBe(0);
  });

  it('повторный close и close несуществующего id безвредны', () => {
    const r = new InboundSocketRegistry();
    const s = fakeSocket();
    const id = r.add(s, NOW);
    r.close(id);
    r.close(id);
    r.close(4242);
    expect(s.destroyed).toBe(1);
    expect(r.size).toBe(0);
  });

  it('closeAll закрывает всё и оставляет реестр пустым', () => {
    const r = new InboundSocketRegistry();
    const sockets = [fakeSocket(), fakeSocket(), fakeSocket()];
    for (const s of sockets) r.add(s, NOW);
    r.closeAll();
    expect(sockets.every((s) => s.destroyed === 1)).toBe(true);
    expect(r.size).toBe(0);
  });

  it('исключение из destroy не роняет уборку остальных', () => {
    const r = new InboundSocketRegistry();
    const bad: ClosableSocket = {
      destroy(): void {
        throw new Error('socket already gone');
      },
    };
    const good = fakeSocket();
    r.add(bad, NOW);
    r.add(good, NOW);
    expect(() => r.closeAll()).not.toThrow();
    expect(good.destroyed).toBe(1);
    expect(r.size).toBe(0);
  });

  it('id не переиспользуются после закрытия', () => {
    const r = new InboundSocketRegistry();
    const first = fakeSocket();
    const id1 = r.add(first, NOW);
    r.close(id1);
    const second = fakeSocket();
    const id2 = r.add(second, NOW);
    expect(id2).not.toBe(id1);
    // touch по устаревшему id не должен трогать чужую запись.
    r.touch(id1, NOW + 99_999);
    expect(r.sweep(NOW + LAN_INBOUND_IDLE_MS + 1)).toBe(1);
    expect(second.destroyed).toBe(1);
  });
});
