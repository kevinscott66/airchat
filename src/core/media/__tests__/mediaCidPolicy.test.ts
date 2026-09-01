import { parseMediaCidsColumn, sanitizeMediaCids, serializeMediaCids } from '../mediaCidPolicy';
import { makeNbCid } from '../blobRef';

const CID_A = 'Qm' + 'a'.repeat(44);
const CID_B = 'Qm' + 'b'.repeat(44);
const NB = makeNbCid({ u: 'https://ntfy.sh/file/x.bin', k: 'a'.repeat(44), m: 'image/jpeg' });

describe('parseMediaCidsColumn', () => {
  it('читает формат входящих сообщений (JSON-массив)', () => {
    expect(parseMediaCidsColumn(JSON.stringify([CID_A, CID_B]))).toEqual([CID_A, CID_B]);
  });

  it('читает старый формат своих сообщений (через запятую)', () => {
    expect(parseMediaCidsColumn(`${CID_A}, ${CID_B}`)).toEqual([CID_A, CID_B]);
  });

  it('не режет по запятой дескриптор вложения — внутри него свои запятые', () => {
    expect(NB).toContain(',');
    expect(parseMediaCidsColumn(serializeMediaCids([NB]))).toEqual([NB]);
  });

  it('пустое и мусорное значение дают пустой список', () => {
    expect(parseMediaCidsColumn(null)).toEqual([]);
    expect(parseMediaCidsColumn('')).toEqual([]);
    expect(parseMediaCidsColumn('   ')).toEqual([]);
    expect(parseMediaCidsColumn('[не json')).toEqual(['[не json']);
  });

  it('оборванный JSON не роняет разбор', () => {
    expect(() => parseMediaCidsColumn('["Qm')).not.toThrow();
  });

  it('нестроковые элементы массива отбрасываются', () => {
    expect(parseMediaCidsColumn(JSON.stringify([CID_A, 42, null, {}]))).toEqual([CID_A]);
  });
});

describe('sanitizeMediaCids', () => {
  it('пропускает обычный CID', () => {
    expect(sanitizeMediaCids([CID_A])).toEqual([CID_A]);
  });

  it('пропускает дескриптор зашифрованного вложения — без него фото в группе не доезжает', () => {
    expect(sanitizeMediaCids([NB])).toEqual([NB]);
  });

  it('отбрасывает попытку увести загрузку на чужой сервер', () => {
    expect(sanitizeMediaCids(['x/../../../https:/evil.example/p.png'])).toEqual([]);
    expect(sanitizeMediaCids(['https://evil.example/p.png'])).toEqual([]);
    expect(sanitizeMediaCids(['../../etc/passwd'])).toEqual([]);
  });

  it('отбрасывает дескриптор без ключа или без источника', () => {
    expect(sanitizeMediaCids([`nb:${JSON.stringify({ u: 'https://ntfy.sh/f' })}`])).toEqual([]);
    expect(sanitizeMediaCids([`nb:${JSON.stringify({ k: 'a'.repeat(44) })}`])).toEqual([]);
    expect(sanitizeMediaCids(['nb:{сломанный json'])).toEqual([]);
  });

  it('отбрасывает дескриптор с не-http источником', () => {
    expect(sanitizeMediaCids([`nb:${JSON.stringify({ u: 'file:///etc/passwd', k: 'a'.repeat(44) })}`])).toEqual([]);
  });

  it('обрезает список до потолка ДО разбора', () => {
    const many = Array.from({ length: 10_000 }, () => CID_A);
    expect(sanitizeMediaCids(many)).toHaveLength(32);
  });

  it('не массив — пустой список', () => {
    expect(sanitizeMediaCids(null)).toEqual([]);
    expect(sanitizeMediaCids({ length: 3 })).toEqual([]);
    expect(sanitizeMediaCids('Qm')).toEqual([]);
  });
});

describe('serializeMediaCids ↔ parseMediaCidsColumn', () => {
  it('обход туда-обратно сохраняет список', () => {
    const list = [CID_A, NB, CID_B];
    expect(parseMediaCidsColumn(serializeMediaCids(list))).toEqual(list);
  });
});
