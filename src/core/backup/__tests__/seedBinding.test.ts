import {
  SEED_BINDING_KDF_ITERS,
  SEED_BINDING_SALT_BYTES,
  SEED_BINDING_VERSION,
  decryptSeedBinding,
  encryptSeedBinding,
  type SeedBindingEnvelope,
} from '../seedBinding';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'пароль-приложения';

/**
 * PBKDF2 здесь намеренно тяжёлый (600 000 итераций ≈ секунда), поэтому конверт
 * считается один раз на весь файл, а планка ожидания поднята: иначе тест
 * падал бы не на ошибке, а на пятисекундном пределе jest.
 */
jest.setTimeout(30_000);

let envelope: SeedBindingEnvelope;

beforeAll(() => {
  envelope = encryptSeedBinding(MNEMONIC, PASSWORD, 1_700_000_000_000);
});

describe('seed binding envelope', () => {
  it('прячет слова и описывает себя', () => {
    expect(envelope.v).toBe(SEED_BINDING_VERSION);
    expect(envelope.iters).toBe(SEED_BINDING_KDF_ITERS);
    expect(envelope.savedAt).toBe(1_700_000_000_000);
    expect(Buffer.from(envelope.saltB64, 'base64')).toHaveLength(SEED_BINDING_SALT_BYTES);
    // Ни слова наружу: ни открытым текстом, ни в base64 самих слов.
    expect(envelope.dataB64).not.toContain('abandon');
    expect(envelope.dataB64).not.toContain(Buffer.from(MNEMONIC, 'utf8').toString('base64').slice(0, 24));
  });

  it('открывается тем же паролем', () => {
    expect(decryptSeedBinding(envelope, PASSWORD)).toBe(MNEMONIC);
  });

  it('не открывается чужим паролем', () => {
    expect(decryptSeedBinding(envelope, 'пароль-приложенья')).toBeNull();
  });

  it('терпит регистр и лишние пробелы в словах', () => {
    const messy = encryptSeedBinding(`  ${MNEMONIC.toUpperCase().replace(/ /g, '   ')}  `, PASSWORD);
    expect(decryptSeedBinding(messy, PASSWORD)).toBe(MNEMONIC);
  });

  it('отказывается шифровать не-слова и слабый пароль', () => {
    expect(() => encryptSeedBinding('корова корова корова', PASSWORD)).toThrow(/слова/i);
    expect(() => encryptSeedBinding(MNEMONIC, '12345')).toThrow(/минимум/i);
    expect(() => encryptSeedBinding(MNEMONIC, ' пароль ')).toThrow(/пробел/i);
  });

  it('не принимает конверт с заниженным KDF', () => {
    // Заниженный `iters` — попытка удешевить перебор пароля. Ключ по нему
    // считать нельзя даже ради проверки: конверт отвергается по форме.
    expect(decryptSeedBinding({ ...envelope, iters: 1000 }, PASSWORD)).toBeNull();
    expect(decryptSeedBinding({ ...envelope, iters: SEED_BINDING_KDF_ITERS - 1 }, PASSWORD)).toBeNull();
  });

  it('не принимает конверт чужой версии и порченый', () => {
    expect(decryptSeedBinding({ ...envelope, v: SEED_BINDING_VERSION + 1 }, PASSWORD)).toBeNull();
    expect(decryptSeedBinding({ ...envelope, saltB64: 'AAEC' }, PASSWORD)).toBeNull();
    expect(decryptSeedBinding(null, PASSWORD)).toBeNull();
  });

  it('даёт разный шифртекст на одних и тех же словах', () => {
    const again = encryptSeedBinding(MNEMONIC, PASSWORD);
    expect(again.saltB64).not.toBe(envelope.saltB64);
    expect(again.dataB64).not.toBe(envelope.dataB64);
  });
});
