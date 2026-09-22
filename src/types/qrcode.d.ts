/**
 * Та часть `qrcode`, которой пользуется `BrandedQr`: собрать матрицу и узнать
 * её версию. Сам пакет приходит вместе с `react-native-qrcode-svg`.
 */
declare module 'qrcode' {
  export type QRCodeErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';
  export function create(
    text: string,
    options?: { errorCorrectionLevel?: QRCodeErrorCorrectionLevel },
  ): { version: number; modules: { size: number } };
  const QRCode: { create: typeof create };
  export default QRCode;
}
