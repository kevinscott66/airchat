/**
 * resolveMediaCids: что именно вызывающий узнаёт о судьбе вложений (v4.32.359).
 *
 * Оба вызывающих — открытие одноразового снимка. Показав список, они СТИРАЮТ
 * сообщение, а строка в базе держит единственную ссылку на вложение. Поэтому
 * «сколько не открылось» здесь не украшение отчёта, а условие удаления.
 */

const mockResolved = new Map<string, string | null>();
const mockThrows = new Set<string>();
let mockConcurrent = 0;
let mockPeakConcurrent = 0;

jest.mock('../mediaBlob', () => ({
  parseNbCid: (cid: string) => (cid.startsWith('nb:') ? { u: 'https://ntfy.sh/x', k: 'k', i: cid.slice(3) } : null),
  resolveBlobToLocalFile: jest.fn(async (ref: { i: string }) => {
    mockConcurrent += 1;
    mockPeakConcurrent = Math.max(mockPeakConcurrent, mockConcurrent);
    await new Promise<void>((r) => setTimeout(r, 0));
    mockConcurrent -= 1;
    if (mockThrows.has(ref.i)) throw new Error('сеть недоступна');
    return mockResolved.has(ref.i) ? mockResolved.get(ref.i) : `file:///cache/airchat_media_${ref.i}.img`;
  }),
}));

import { resolveMediaCidsToUris } from '../resolveMediaCids';

const GW = 'https://gw.example';
const CID_A = 'Qm' + 'a'.repeat(44);
const CID_B = 'Qm' + 'b'.repeat(44);

beforeEach(() => {
  mockResolved.clear();
  mockThrows.clear();
  mockConcurrent = 0;
  mockPeakConcurrent = 0;
});

describe('resolveMediaCidsToUris', () => {
  it('пустая колонка — пустой список без потерь', async () => {
    await expect(resolveMediaCidsToUris(null, GW)).resolves.toEqual({ uris: [], missing: 0 });
    await expect(resolveMediaCidsToUris('', GW)).resolves.toEqual({ uris: [], missing: 0 });
  });

  it('обычный CID превращается в адрес шлюза', async () => {
    const r = await resolveMediaCidsToUris(JSON.stringify([CID_A]), GW);
    expect(r).toEqual({ uris: [`${GW}/ipfs/${CID_A}`], missing: 0 });
  });

  it('nb-дескриптор расшифровывается в файл кэша', async () => {
    const r = await resolveMediaCidsToUris(JSON.stringify(['nb:one']), GW);
    expect(r.uris).toEqual(['file:///cache/airchat_media_one.img']);
    expect(r.missing).toBe(0);
  });

  it('порядок колонки сохраняется', async () => {
    // Просмотрщик открывается по индексу: перепутанный порядок — это открытый
    // не тот снимок.
    const r = await resolveMediaCidsToUris(JSON.stringify(['nb:one', CID_A, 'nb:two']), GW);
    expect(r.uris).toEqual([
      'file:///cache/airchat_media_one.img',
      `${GW}/ipfs/${CID_A}`,
      'file:///cache/airchat_media_two.img',
    ]);
  });

  it('неоткрывшееся вложение считается, а не исчезает молча', async () => {
    // Раньше запись просто отпадала, и вызывающий не мог отличить «показали
    // всё» от «показали половину» — а стирал сообщение в обоих случаях.
    mockResolved.set('two', null);
    const r = await resolveMediaCidsToUris(JSON.stringify(['nb:one', 'nb:two']), GW);
    expect(r.uris).toEqual(['file:///cache/airchat_media_one.img']);
    expect(r.missing).toBe(1);
  });

  it('отказ расшифровки не роняет остальные', async () => {
    mockThrows.add('two');
    const r = await resolveMediaCidsToUris(JSON.stringify(['nb:one', 'nb:two', 'nb:three']), GW);
    expect(r.uris).toEqual([
      'file:///cache/airchat_media_one.img',
      'file:///cache/airchat_media_three.img',
    ]);
    expect(r.missing).toBe(1);
  });

  it('ни одно вложение не открылось — пустой список и полный счёт потерь', async () => {
    mockResolved.set('one', null);
    mockResolved.set('two', null);
    const r = await resolveMediaCidsToUris(JSON.stringify(['nb:one', 'nb:two']), GW);
    expect(r).toEqual({ uris: [], missing: 2 });
  });

  describe('негодные записи колонки', () => {
    it('CID вида "../" адресом не становится', async () => {
      // Форму проверяет gatewayUrl: такой «CID» увёл бы загрузку на чужой
      // сервер и выдал бы IP получателя.
      const r = await resolveMediaCidsToUris(JSON.stringify(['../'.repeat(20) + 'a'.repeat(20)]), GW);
      expect(r.uris).toEqual([]);
      expect(r.missing).toBe(1);
    });

    it('без адреса шлюза обычный CID тоже не проходит', async () => {
      const r = await resolveMediaCidsToUris(JSON.stringify([CID_A, CID_B]), '');
      expect(r).toEqual({ uris: [], missing: 2 });
    });

    it('nb-вложения от отсутствующего шлюза не зависят', async () => {
      const r = await resolveMediaCidsToUris(JSON.stringify(['nb:one']), null);
      expect(r.uris).toEqual(['file:///cache/airchat_media_one.img']);
    });

    it('испорченная колонка — пустой список, а не отказ', async () => {
      const r = await resolveMediaCidsToUris('{не json', GW);
      expect(r.uris).toEqual([]);
    });
  });

  it('вложения расшифровываются параллельно, но не больше четырёх сразу', async () => {
    // Последовательно это была очередь загрузок с таймаутом в 30 секунд
    // каждая: нажатие на снимок из десяти оборачивалось минутами пустоты.
    const cids = Array.from({ length: 10 }, (_, i) => `nb:x${i}`);
    const r = await resolveMediaCidsToUris(JSON.stringify(cids), GW);
    expect(r.uris).toHaveLength(10);
    expect(mockPeakConcurrent).toBeGreaterThan(1);
    expect(mockPeakConcurrent).toBeLessThanOrEqual(4);
  });
});
