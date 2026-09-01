/**
 * Чужой CID не должен уводить загрузку картинки на чужой сервер.
 */

import { isPlainCid } from '../../cid';
import { gatewayUrl, normalizeGateway } from '../gatewayUrl';

const GW = 'https://ipfs.example';
const CID = 'Qm' + 'a'.repeat(44);

describe('isPlainCid', () => {
  it('CIDv0 и base32 CIDv1 проходят', () => {
    expect(isPlainCid(CID)).toBe(true);
    expect(isPlainCid('b' + 'a'.repeat(58))).toBe(true);
  });

  it('значащие для адреса символы, пустое и не строка — нет', () => {
    for (const v of [
      '', '..', '../..', `${CID}/../evil`, `${CID}?x=1`, `${CID}#a`, `${CID}@evil.example`,
      'https://evil.example/p.png', 'a'.repeat(45), 'a'.repeat(129), ' ' + CID, CID + ' ',
      null, undefined, 0, {}, [CID],
    ]) {
      expect(isPlainCid(v)).toBe(false);
    }
  });
});

describe('normalizeGateway', () => {
  it('хвостовые слэши убираются', () => {
    expect(normalizeGateway(`${GW}///`)).toBe(GW);
    expect(normalizeGateway(`  ${GW}  `)).toBe(GW);
  });

  it('не http(s) или пусто — пустая строка', () => {
    for (const gw of [null, undefined, '', '   ', 'ftp://x', 'javascript:alert(1)', 'ipfs.example', '//evil.example']) {
      expect(normalizeGateway(gw)).toBe('');
    }
  });
});

describe('gatewayUrl', () => {
  it('обычный CID', () => {
    expect(gatewayUrl(GW, CID)).toBe(`${GW}/ipfs/${CID}`);
    expect(gatewayUrl(`${GW}/`, CID)).toBe(`${GW}/ipfs/${CID}`);
  });

  it('подмена сервера через CID не проходит', () => {
    for (const cid of [
      '../../evil.example/p.png',
      `${CID}/../../evil.example`,
      'x/../../../https:/evil.example/p.png',
      '@evil.example',
      `${CID}?r=https://evil.example`,
    ]) {
      expect(gatewayUrl(GW, cid)).toBe('');
    }
  });

  it('без шлюза адрес не собирается', () => {
    expect(gatewayUrl(null, CID)).toBe('');
    expect(gatewayUrl('', CID)).toBe('');
  });
});
