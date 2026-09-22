/**
 * Знак в середине QR-кода — только там, где код его выдерживает.
 *
 * Решение о знаке принимает `planQr`, и проверяется оно, а не отрисовка:
 * читаемость кода со знаком проверена декодерами (jsQR, ZXing) на строке
 * контакта и на самой длинной строке, что ещё получает знак.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import QRMatrix from 'qrcode';
import { buildContactLink } from '../../../core/net/appLink';
import { LOGO_MAX_VERSION, LOGO_SHARE, planQr } from '../BrandedQr';
import { BRAND_MARK } from '../../theme';

const pub = Buffer.alloc(32, 7).toString('base64');

describe('planQr', () => {
  it('контакт получает знак на уровне H', () => {
    expect(planQr(buildContactLink(pub).web)).toEqual({ ecl: 'H', logo: true });
  });

  it('знак — не больше версии, в которой модуль ещё крупный', () => {
    const value = 'https://air.dobropalm.tech/g/' + 'A'.repeat(185);
    expect(planQr(value)).toEqual({ ecl: 'H', logo: true });
    expect(QRMatrix.create(value, { errorCorrectionLevel: 'H' }).version).toBeLessThanOrEqual(LOGO_MAX_VERSION);
  });

  it('длинная строка идёт без знака и без H', () => {
    expect(planQr('x'.repeat(600))).toEqual({ ecl: 'M', logo: false });
  });

  it('то, что не лезет в M, рисуется на L, а не роняет окно', () => {
    expect(planQr('x'.repeat(2500))).toEqual({ ecl: 'L', logo: false });
    expect(planQr('x'.repeat(4000))).toBeNull();
  });

  it('краски знака — те же, что в файле иконки', () => {
    const svg = readFileSync(join(__dirname, '..', '..', '..', '..', 'assets', 'logo', 'airchat-mark.svg'), 'utf8');
    expect(svg).toContain(`stop-color="${BRAND_MARK.from}"`);
    expect(svg).toContain(`stop-color="${BRAND_MARK.to}"`);
  });

  it('плашка знака — не больше четверти стороны', () => {
    expect(LOGO_SHARE).toBeLessThanOrEqual(0.25);
  });
});

describe('все коды приложения — через BrandedQr', () => {
  const SRC = join(__dirname, '..', '..', '..');
  for (const rel of [
    'ui/screens/ProfileScreen.tsx',
    'ui/components/modals/profile/ProfileQrModal.tsx',
    'ui/components/modals/groups/GroupQrModal.tsx',
  ]) {
    it(rel, () => {
      const src = readFileSync(join(SRC, rel), 'utf8');
      expect(src).toContain('<BrandedQr ');
      expect(src).not.toContain('react-native-qrcode-svg');
    });
  }
});
