import {
  SEED_BINDING_KDF_ITERS,
  SEED_BINDING_SALT_BYTES,
  SEED_BINDING_VERSION,
  encryptSeedBinding,
  openSeedBinding,
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
    expect(openSeedBinding(envelope, PASSWORD)).toEqual({ ok: true, mnemonic: MNEMONIC });
  });

  it('не открывается чужим паролем — и отказ назван паролем', () => {
    // v4.32.1079: прежде здесь был безымянный null. Важно не только то, что
    // конверт не открылся, но и то, что виноватым назван пароль: именно этот
    // разряд экран отвечает предложением ввести его заново.
    expect(openSeedBinding(envelope, 'пароль-приложенья')).toEqual({
      ok: false,
      why: 'wrong_password',
    });
  });

  it('терпит регистр и лишние пробелы в словах', () => {
    const messy = encryptSeedBinding(`  ${MNEMONIC.toUpperCase().replace(/ /g, '   ')}  `, PASSWORD);
    expect(openSeedBinding(messy, PASSWORD)).toEqual({ ok: true, mnemonic: MNEMONIC });
  });

  it('отказывается шифровать не-слова и слабый пароль', () => {
    expect(() => encryptSeedBinding('корова корова корова', PASSWORD)).toThrow(/слова/i);
    expect(() => encryptSeedBinding(MNEMONIC, '12345')).toThrow(/минимум/i);
    expect(() => encryptSeedBinding(MNEMONIC, ' пароль ')).toThrow(/пробел/i);
  });

  it('не принимает конверт с заниженным KDF', () => {
    // Заниженный `iters` — попытка удешевить перебор пароля. Ключ по нему
    // считать нельзя даже ради проверки: конверт отвергается по форме.
    // v4.32.1079: отказ по форме конверта — не «неверный пароль».
    expect(openSeedBinding({ ...envelope, iters: 1000 }, PASSWORD).ok).toBe(false);
    expect(openSeedBinding({ ...envelope, iters: SEED_BINDING_KDF_ITERS - 1 }, PASSWORD))
      .toEqual({ ok: false, why: 'broken_envelope' });
  });

  it('не принимает конверт чужой версии и порченый', () => {
    // Версия новее — свой разряд: его чинят обновлением приложения, а не
    // подбором пароля (v4.32.1079).
    expect(openSeedBinding({ ...envelope, v: SEED_BINDING_VERSION + 1 }, PASSWORD))
      .toEqual({ ok: false, why: 'newer_envelope' });
    expect(openSeedBinding({ ...envelope, saltB64: 'AAEC' }, PASSWORD))
      .toEqual({ ok: false, why: 'broken_envelope' });
    expect(openSeedBinding(null, PASSWORD)).toEqual({ ok: false, why: 'no_envelope' });
  });

  it('даёт разный шифртекст на одних и тех же словах', () => {
    const again = encryptSeedBinding(MNEMONIC, PASSWORD);
    expect(again.saltB64).not.toBe(envelope.saltB64);
    expect(again.dataB64).not.toBe(envelope.dataB64);
  });
});
