import { decideJoin, acceptJoinRequest } from '../groupJoinPolicy';

const base = { knownRole: undefined, requireApproval: false, iAmAdmin: false } as const;

describe('groupJoinPolicy.decideJoin', () => {
  it('без одобрения незнакомец становится участником', () => {
    expect(decideJoin({ ...base })).toBe('add');
    expect(decideJoin({ ...base, iAmAdmin: true })).toBe('add');
  });

  it('с одобрением незнакомец сам себя не добавляет', () => {
    // Ровно эта дыра: раньше конверт 'join' применялся безоговорочно, и
    // подделанная ссылка с requireApproval:false проводила мимо гейта.
    expect(decideJoin({ ...base, requireApproval: true, iAmAdmin: true })).toBe('queue');
    expect(decideJoin({ ...base, requireApproval: true, iAmAdmin: false })).toBe('ignore');
  });

  it('забаненный не возвращается ни при какой настройке', () => {
    for (const requireApproval of [true, false]) {
      for (const iAmAdmin of [true, false]) {
        expect(decideJoin({ knownRole: 'banned', requireApproval, iAmAdmin })).toBe('banned');
      }
    }
  });

  it('уже участник — повторное представление ничего не меняет', () => {
    for (const knownRole of ['owner', 'admin', 'member', 'restricted'] as const) {
      expect(decideJoin({ knownRole, requireApproval: false, iAmAdmin: true })).toBe('ignore');
    }
  });

  it('одобренный участник не попадает в заявки заново', () => {
    // Переустановка приложения у участника: он представляется конвертом
    // 'join' ещё раз, а мы его уже знаем. Гейт не должен выкидывать своего
    // обратно в очередь заявок.
    expect(decideJoin({ knownRole: 'member', requireApproval: true, iAmAdmin: true })).toBe('ignore');
  });

  it('«только контакты» отсекает заявку и на этом пути тоже', () => {
    // Настройка приватности обходилась той же правкой ссылки, что и гейт
    // одобрения: конверт 'join' о ней просто не знал.
    const gated = { ...base, requireApproval: true, iAmAdmin: true, onlyContactsMayRequest: true };
    expect(decideJoin({ ...gated, requesterIsContact: false })).toBe('ignore');
    expect(decideJoin({ ...gated, requesterIsContact: true })).toBe('queue');
  });

  it('«только контакты» не закрывает вход в группу без одобрения', () => {
    // Настройка защищает от чужих заявок, а не превращает открытую по ссылке
    // группу в закрытую: без гейта незнакомец входит как и раньше.
    expect(decideJoin({ ...base, onlyContactsMayRequest: true, requesterIsContact: false })).toBe('add');
  });
});

describe('groupJoinPolicy.acceptJoinRequest', () => {
  const open = { knownRole: undefined, requesterIsContact: false, onlyContactsMayRequest: false };

  it('по умолчанию заявка проходит', () => {
    expect(acceptJoinRequest(open)).toBe(true);
  });

  it('забаненный до списка заявок не доходит', () => {
    // Раньше личный конверт '\x0agjr:' клал забаненного в список, и отказ
    // «заблокирован(а)» администратор видел уже после нажатия «Принять».
    expect(acceptJoinRequest({ ...open, knownRole: 'banned' })).toBe(false);
    expect(acceptJoinRequest({ ...open, knownRole: 'banned', requesterIsContact: true })).toBe(false);
  });

  it('незнакомец отсекается только при включённой настройке', () => {
    expect(acceptJoinRequest({ ...open, onlyContactsMayRequest: true })).toBe(false);
    expect(acceptJoinRequest({ ...open, onlyContactsMayRequest: true, requesterIsContact: true })).toBe(true);
  });

  it('выбывший участник может попроситься обратно', () => {
    // Переустановка: группа у человека пропала, у нас он ещё числится. Заявку
    // нужно показать — иначе вернуть его в группу нечем.
    for (const knownRole of ['member', 'admin', 'owner', 'restricted'] as const) {
      expect(acceptJoinRequest({ ...open, knownRole })).toBe(true);
    }
  });
});
