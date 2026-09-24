/**
 * Отложенный личный конверт больше не пропадает навсегда (v4.32.790).
 *
 * Дефект. Отметка `seenMessageIds` ставится ДО разбора конверта: входов у него
 * три (общая тема, свой ящик, локальная сеть), и разбирать один кадр трижды
 * нельзя. Но снималась отметка только на выходах `'consumed'` — там, где разбор
 * осознанно отказывался от конверта («ключ не наш», «не расшифровалось», «не
 * объект», «метка вне окна»). Ни один из восьми выходов `'deferred'` и ни один
 * из тринадцати обработчиков, которые могут ответить тем же словом (группы,
 * истории, реакции, голоса, закрепления, исчезающие, профили), отметку не
 * снимал.
 *
 * Цена. Единственная повторная попытка, которую даёт координатор интернета,
 * входила в разбор снова, натыкалась на отметку первой же строкой и отвечала
 * `'consumed'` — молча, без записи в журнале. Метка «докуда прочитано»
 * перешагивала кадр, `giveUp('internet_frame_deferred_again')` не срабатывал
 * никогда. То есть механизм отсрочки для личного транспорта не работал вовсе:
 * всё, что упёрлось в занятую базу, пропадало навсегда при «Доставлено» у
 * отправителя. Вход по CID (`receiveCid`) рассчитан на следующий заход по тому
 * же CID — и этот заход упирался в ту же отметку.
 *
 * Правка. Снятие связано со словом `'deferred'`, а не с местом, где оно
 * произносится: разбор целиком обёрнут, и новая ветка отсрочки об этом уже не
 * забудет. Образец дисциплины — ленты (`feedService`), где `feedSeenForget`
 * зовётся перед каждой отсрочкой руками.
 *
 * Проверка идёт по исходнику: `messaging.ts` тянет `uuid`, который приходит как
 * ESM и не проходит трансформацию jest (тот же довод, что в
 * `groupIntakeVerdict736.test.ts`). Вторая половина дороги — что координатор
 * действительно отпускает кадр со второй отсрочки — проверена поведением в
 * `transport/internet/__tests__/backlogIntake730.test.ts`.
 */
import fs from 'fs';
import path from 'path';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** Только код: комментарии не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const MSG = codeOnly(read('messaging.ts'));
const GRP = codeOnly(read('groupMessaging.ts'));
const FEED = codeOnly(read('feedService.ts'));
const COORD = codeOnly(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'transport', 'internet', 'internetCoordinator.ts'),
    'utf8',
  ),
);

/** Кусок исходника между двумя опорами. Обе обязаны найтись и идти по порядку. */
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(end, a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

/** Сколько раз подстрока встречается в тексте. */
const times = (src: string, needle: string): number => src.split(needle).length - 1;

/**
 * Обёртка: от её объявления до объявления самого разбора.
 *
 * Куски вырезаются лениво, а не при загрузке модуля: на коде ДО правки обёртки
 * нет вовсе, и вырезание при загрузке уронило бы весь набор целиком — вместе с
 * блоками «ПРОВЕРКА НЕ ПУСТАЯ» и «ПОВОД ДЛЯ ПРАВКИ ЖИВ», которые обязаны
 * проходить и там.
 */
const wrapper = (): string =>
  between(
    MSG,
    '  private async persistIncomingFromEnvelope(',
    '  private async persistIncomingFromEnvelopeInner(',
  );
/** Сам разбор: от его объявления до следующего метода класса. */
const inner = (): string =>
  between(
    MSG,
    '  private async persistIncomingFromEnvelopeInner(',
    '  private async uploadMediaFromUri(',
  );
/** Разбор под прежним именем — он же на коде до правки. */
const parse = (): string =>
  between(MSG, '  private async persistIncomingFromEnvelope', '  private async uploadMediaFromUri(');

describe('отсрочка возвращает конверт памяти повторов', () => {
  it('обёртка снимает отметку ровно на слове «отложено»', () => {
    expect(wrapper()).toContain(
      "if (verdict === 'deferred') this.seenMessageIds.delete(em.messageId);",
    );
    expect(wrapper()).toContain('return verdict;');
  });

  it('разбор доступен только через обёртку', () => {
    // Иначе мимо снятия отметки нашлась бы дорога.
    expect(times(MSG, 'persistIncomingFromEnvelopeInner(')).toBe(2);
    expect(wrapper()).toContain('await this.persistIncomingFromEnvelopeInner(');
    // Внутри тела разбора имени нет: рекурсии, обходящей обёртку, не заведено.
    const body = inner();
    expect(body.slice(body.indexOf('const myDid = publicKeyToDidKey('))).not.toContain(
      'persistIncomingFromEnvelopeInner(',
    );
  });

  it('оба внешних входа зовут обёртку, а не разбор', () => {
    expect(MSG).toContain(
      'await this.persistIncomingFromEnvelope(em, peerPubKeyB64, cid, undefined, allowSelfAuthored);',
    );
    expect(MSG).toContain(
      'return await this.persistIncomingFromEnvelope(em, peerPubKeyB64, storageCid, pt);',
    );
  });

  it('ни один выход отсрочки внутри разбора не остался без прикрытия', () => {
    // Обёртка накрывает их все разом; на всякий случай пересчитываем, чтобы
    // заметить, если кто-то начнёт снимать отметку ещё и руками — тогда пары
    // снова начнут расходиться.
    expect(times(inner(), "return 'deferred';")).toBeGreaterThanOrEqual(7);
    const manual = between(
      inner(),
      "if (this.seenMessageIds.has(em.messageId)) return 'consumed';",
      '\n  }\n',
    );
    expect(times(manual, 'this.seenMessageIds.delete(em.messageId);')).toBe(6);
  });
});

describe('настоящие дубли отсекаются по-прежнему', () => {
  it('отметка ставится до разбора и остаётся на разобранном', () => {
    expect(parse()).toContain("if (this.seenMessageIds.has(em.messageId)) return 'consumed';");
    expect(parse()).toContain('this.markSeen(em.messageId);');
  });

  it('осознанные отказы снимают отметку сами — это не отсрочка', () => {
    // «Ключ не наш», «не расшифровалось», «не объект», «метка вне окна» — все
    // четыре отвечают `'consumed'`, и снятие там своё, не от обёртки.
    const notOurs = between(parse(), 'const sym = await getSymmetricKeyForPeer(', 'pt = decryptSymmetric(');
    expect(notOurs).toContain('this.seenMessageIds.delete(em.messageId);');
    expect(notOurs).toContain("return 'consumed';");
  });

  it('пересылка чужого кадра метит отдельно и разбора не касается', () => {
    const relay = between(MSG, 'private async maybeRelayDm(', 'async receiveDirectLanEnvelope(');
    expect(relay).toContain('if (this.seenMessageIds.has(em.messageId)) {');
    expect(relay).toContain('this.markSeen(em.messageId);');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обработчикам есть что отложить', () => {
  it('нечитаемый состав группы — это «перезапросить»', () => {
    const handler = between(
      GRP,
      'export async function handleIncomingGroupEnvelope(',
      'export const GROUP_JOIN_REQUEST_PREFIX',
    );
    expect(handler).toContain("return 'deferred';");
  });

  it('разбор делегирует тринадцати обработчикам, и их ответ идёт наружу', () => {
    expect(times(parse(), 'return await handleIncoming')).toBeGreaterThanOrEqual(13);
  });

  it('отказ записи обычного сообщения откладывает кадр (v4.32.771 и раньше)', () => {
    expect(parse()).toContain("log.warn('dm_save_failed_defer', {");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('координатор даёт ровно одну лишнюю попытку и после сдвигает метку', () => {
    expect(COORD).toContain('if (failedOnce.has(frameAtMs)) {');
    expect(COORD).toContain("giveUp('internet_frame_deferred_again');");
    // v4.32.831: продвижение зовётся через markDone — кадры пачки заканчивают
    // разбор не в том порядке, в каком пришли, и он помнит, докуда закончено.
    expect(COORD).toContain('markDone(frameAtMs);');
  });

  it('личный транспорт входит в разбор именно через координатор', () => {
    expect(COORD).toContain("(await getMessagingService()?.receiveDirectLanEnvelope(payload, senderDid)) ??");
  });

  it('вход по CID рассчитывает на следующий заход по тому же CID', () => {
    const byCid = between(MSG, 'async receiveCid(cid: string,', 'async receiveDirectLanEnvelope(');
    expect(byCid).toContain('await this.persistIncomingFromEnvelope(em, peerPubKeyB64, cid, undefined, allowSelfAuthored);');
  });

  it('образец дисциплины — ленты — снимает отметку перед каждой отсрочкой руками', () => {
    expect(times(FEED, 'feedSeenForget(dedupKey);')).toBeGreaterThanOrEqual(4);
    expect(FEED).toContain('if (feedSeenMarkOrHas(dedupKey)) {');
  });
});
