/**
 * Единая планка длины пароля.
 *
 * Проверяется не только сама функция, но и то, ради чего она заведена: до
 * v4.32.595 приложение требовало четыре символа, а облачная копия —
 * двенадцать, и пароль, годный для входа, отвергался при отправке копии.
 */
import { PASSWORD_MIN_LENGTH, passwordPolicyError } from '../passwordPolicy';
import { validateCloudPassword } from '../../backup/cloudVault';

describe('passwordPolicy', () => {
  it('короткий пароль отвергается, ровный по планке — принимается', () => {
    expect(passwordPolicyError('1'.repeat(PASSWORD_MIN_LENGTH - 1))).not.toBeNull();
    expect(passwordPolicyError('1'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
  });

  it('пробел по краям отвергается: его не видно, а в проверку он попадает', () => {
    expect(passwordPolicyError(' 123456')).not.toBeNull();
    expect(passwordPolicyError('123456 ')).not.toBeNull();
    expect(passwordPolicyError('123 456')).toBeNull();
  });

  it('длина считается по символам, а не по кодовым единицам', () => {
    // Шесть эмодзи — двенадцать единиц UTF-16; планка не должна пропускать
    // строку только потому, что она «длинная» в памяти.
    expect(passwordPolicyError('🙂🙂🙂🙂🙂')).not.toBeNull();
  });

  it('не строка отвергается, а не роняет проверку', () => {
    expect(passwordPolicyError(undefined as unknown as string)).not.toBeNull();
    expect(passwordPolicyError(null as unknown as string)).not.toBeNull();
  });

  it('облачная копия проверяет пароль той же планкой', () => {
    const sixChars = '1'.repeat(PASSWORD_MIN_LENGTH);
    expect(validateCloudPassword(sixChars)).toBeNull();
    expect(validateCloudPassword(sixChars)).toBe(passwordPolicyError(sixChars));
    const tooShort = '1'.repeat(PASSWORD_MIN_LENGTH - 1);
    expect(validateCloudPassword(tooShort)).toBe(passwordPolicyError(tooShort));
  });
});
