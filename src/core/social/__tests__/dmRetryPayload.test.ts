import { parseDmRetryPayload, serializeDmRetryPayload, type DmRetryPayload } from '../dmRetryPayload';

const PUB = 'A'.repeat(44);
const CID = 'Qm' + 'a'.repeat(44);

function base(): DmRetryPayload {
  return {
    contactPubB64: PUB,
    text: 'привет',
    mediaCids: [],
    messageId: 'msg-1',
    ts: 1_700_000_000_000,
  };
}

describe('parseDmRetryPayload', () => {
  it('разбирает минимальную нагрузку', () => {
    const p = parseDmRetryPayload(serializeDmRetryPayload(base()));
    expect(p).toMatchObject({ contactPubB64: PUB, text: 'привет', mediaCids: [], messageId: 'msg-1' });
  });

  it('переживает круг сериализации без потерь', () => {
    const src: DmRetryPayload = {
      ...base(),
      mediaCids: ['nb:{"u":"https://ntfy.sh/x"}', CID],
      previousMessageCid: CID,
      replyToId: 'msg-0',
      replyToPreview: 'что скажешь?',
    };
    expect(parseDmRetryPayload(serializeDmRetryPayload(src))).toEqual(src);
  });

  it('сохраняет ссылку на цитируемое сообщение', () => {
    // Ради этого поля модуль и появился: в очередь оно не клалось, и ответ,
    // отправленный без сети, доезжал обычным сообщением.
    const p = parseDmRetryPayload(
      serializeDmRetryPayload({ ...base(), replyToId: 'msg-0', replyToPreview: 'вопрос' })
    );
    expect(p?.replyToId).toBe('msg-0');
    expect(p?.replyToPreview).toBe('вопрос');
  });

  it('режет цитату по общему пределу', () => {
    const p = parseDmRetryPayload(
      serializeDmRetryPayload({ ...base(), replyToId: 'msg-0', replyToPreview: 'я'.repeat(500) })
    );
    expect(p?.replyToPreview).toHaveLength(100);
  });

  it('отбрасывает цитату без ссылки на сообщение', () => {
    // Текст цитаты сам по себе не привязан ни к чему — показывать его не к чему.
    const raw = JSON.stringify({ ...base(), replyToPreview: 'висит в воздухе' });
    expect(parseDmRetryPayload(raw)?.replyToPreview).toBeUndefined();
  });

  it('отбрасывает пустую цитату', () => {
    const raw = JSON.stringify({ ...base(), replyToId: 'msg-0', replyToPreview: '' });
    expect(parseDmRetryPayload(raw)?.replyToPreview).toBeUndefined();
  });

  it('отбрасывает нестроковый replyToId', () => {
    const raw = JSON.stringify({ ...base(), replyToId: 42, replyToPreview: 'x' });
    const p = parseDmRetryPayload(raw);
    expect(p?.replyToId).toBeUndefined();
    expect(p?.replyToPreview).toBeUndefined();
  });

  it('отбрасывает слишком длинный replyToId', () => {
    const raw = JSON.stringify({ ...base(), replyToId: 'x'.repeat(129) });
    expect(parseDmRetryPayload(raw)?.replyToId).toBeUndefined();
  });

  describe('непригодная нагрузка', () => {
    it('испорченный JSON', () => {
      expect(parseDmRetryPayload('{не json')).toBeNull();
    });

    it('массив вместо объекта', () => {
      expect(parseDmRetryPayload('[1,2,3]')).toBeNull();
    });

    it('null', () => {
      expect(parseDmRetryPayload('null')).toBeNull();
    });

    it('строка вместо объекта', () => {
      expect(parseDmRetryPayload('"привет"')).toBeNull();
    });

    it('слишком короткий ключ контакта', () => {
      expect(parseDmRetryPayload(JSON.stringify({ ...base(), contactPubB64: 'A'.repeat(42) }))).toBeNull();
    });

    it('слишком длинный ключ контакта', () => {
      expect(parseDmRetryPayload(JSON.stringify({ ...base(), contactPubB64: 'A'.repeat(49) }))).toBeNull();
    });

    it('текст сверх предела', () => {
      expect(parseDmRetryPayload(JSON.stringify({ ...base(), text: 'x'.repeat(64_001) }))).toBeNull();
    });

    it('пустой messageId', () => {
      expect(parseDmRetryPayload(JSON.stringify({ ...base(), messageId: '' }))).toBeNull();
    });

    it('время не число', () => {
      expect(parseDmRetryPayload(JSON.stringify({ ...base(), ts: '1700000000000' }))).toBeNull();
    });

    it('время NaN после круга через JSON', () => {
      // JSON.stringify превращает NaN в null — проверка обязана его поймать.
      expect(parseDmRetryPayload(JSON.stringify({ ...base(), ts: NaN }))).toBeNull();
    });
  });

  describe('вложения', () => {
    it('пустой текст с вложением — обычный случай (фото без подписи)', () => {
      const p = parseDmRetryPayload(JSON.stringify({ ...base(), text: '', mediaCids: [CID] }));
      expect(p?.text).toBe('');
      expect(p?.mediaCids).toEqual([CID]);
    });

    it('нестроковые элементы отпадают, сообщение остаётся', () => {
      const raw = JSON.stringify({ ...base(), mediaCids: [CID, 42, null, { u: 'x' }] });
      expect(parseDmRetryPayload(raw)?.mediaCids).toEqual([CID]);
    });

    it('элемент сверх длины отпадает', () => {
      const raw = JSON.stringify({ ...base(), mediaCids: ['x'.repeat(129), CID] });
      expect(parseDmRetryPayload(raw)?.mediaCids).toEqual([CID]);
    });

    it('список обрезается по потолку', () => {
      const raw = JSON.stringify({ ...base(), mediaCids: Array.from({ length: 100 }, () => CID) });
      expect(parseDmRetryPayload(raw)?.mediaCids).toHaveLength(32);
    });

    it('не массив — пустой список, а не отказ', () => {
      const raw = JSON.stringify({ ...base(), mediaCids: 'Qm…' });
      expect(parseDmRetryPayload(raw)?.mediaCids).toEqual([]);
    });

    it('отсутствующее поле — пустой список', () => {
      const raw = JSON.stringify({ contactPubB64: PUB, text: 'x', messageId: 'm', ts: 1 });
      expect(parseDmRetryPayload(raw)?.mediaCids).toEqual([]);
    });
  });

  describe('previousMessageCid', () => {
    it('настоящий CID проходит', () => {
      expect(parseDmRetryPayload(JSON.stringify({ ...base(), previousMessageCid: CID }))?.previousMessageCid).toBe(CID);
    });

    it('fallback-заглушка отпадает', () => {
      // `fallback:<uuid>` и `lan:` — не CID; связывать по ним цепочку истории
      // нельзя, она встанет на призрачной вершине.
      const raw = JSON.stringify({ ...base(), previousMessageCid: 'fallback:0000' });
      expect(parseDmRetryPayload(raw)?.previousMessageCid).toBeUndefined();
    });

    it('слишком короткий отпадает', () => {
      const raw = JSON.stringify({ ...base(), previousMessageCid: 'Qm123' });
      expect(parseDmRetryPayload(raw)?.previousMessageCid).toBeUndefined();
    });

    it('CID со слэшем отпадает', () => {
      const raw = JSON.stringify({ ...base(), previousMessageCid: '../'.repeat(20) + 'a'.repeat(20) });
      expect(parseDmRetryPayload(raw)?.previousMessageCid).toBeUndefined();
    });
  });
});

describe('serializeDmRetryPayload', () => {
  it('не тащит посторонние поля', () => {
    const withExtra = { ...base(), secret: 'не должно уехать' } as unknown as DmRetryPayload;
    expect(JSON.parse(serializeDmRetryPayload(withExtra))).not.toHaveProperty('secret');
  });

  it('необязательные поля не превращаются в null', () => {
    const parsed = JSON.parse(serializeDmRetryPayload(base())) as Record<string, unknown>;
    expect('replyToId' in parsed).toBe(false);
    expect('previousMessageCid' in parsed).toBe(false);
  });
});
