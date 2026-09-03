import {
  SENSITIVE_NO_PASSWORD_TEXT,
  sensitiveAccessGate,
  unlockSensitiveAccess,
} from '../sensitiveAccess';

const mockHasPassword = jest.fn<Promise<boolean>, []>();
const mockVerifyPassword = jest.fn<Promise<boolean>, [string]>();

jest.mock('../authGuard', () => ({
  authGuard: {
    hasPassword: (): Promise<boolean> => mockHasPassword(),
    verifyPassword: (password: string): Promise<boolean> => mockVerifyPassword(password),
  },
}));

beforeEach(() => {
  mockHasPassword.mockReset();
  mockVerifyPassword.mockReset();
});

test('без пароля дверь ведёт к его созданию, а не внутрь', async () => {
  mockHasPassword.mockResolvedValue(false);
  await expect(sensitiveAccessGate()).resolves.toBe('set_password');
});

test('с паролем дверь спрашивает пароль', async () => {
  mockHasPassword.mockResolvedValue(true);
  await expect(sensitiveAccessGate()).resolves.toBe('verify');
});

test('верный пароль открывает', async () => {
  mockHasPassword.mockResolvedValue(true);
  mockVerifyPassword.mockResolvedValue(true);
  await expect(unlockSensitiveAccess('correct horse')).resolves.toBe('ok');
  expect(mockVerifyPassword).toHaveBeenCalledWith('correct horse');
});

test('неверный пароль не открывает', async () => {
  mockHasPassword.mockResolvedValue(true);
  mockVerifyPassword.mockResolvedValue(false);
  await expect(unlockSensitiveAccess('nope')).resolves.toBe('rejected');
});

test('пустая строка не тратит попытку', async () => {
  mockHasPassword.mockResolvedValue(true);
  await expect(unlockSensitiveAccess('   ')).resolves.toBe('empty');
  expect(mockVerifyPassword).not.toHaveBeenCalled();
  expect(mockHasPassword).not.toHaveBeenCalled();
});

test('когда пароля нет — отдельный ответ, а не «неверный пароль»', async () => {
  mockHasPassword.mockResolvedValue(false);
  await expect(unlockSensitiveAccess('что угодно')).resolves.toBe('no_password');
  expect(mockVerifyPassword).not.toHaveBeenCalled();
  expect(SENSITIVE_NO_PASSWORD_TEXT).toContain('Безопасность');
});
