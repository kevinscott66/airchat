import { publicIdFor } from '../publicId';
import {
  accountRefFor,
  accountRefInfoFor,
  isAccountRef,
  ownAccountRef,
  ownAccountRefInfo,
  readAccountRef,
} from '../accountRef';

// v4.32.573: идентификатор аккаунта ушёл с экрана, и единственным его
// потребителем стал код. Значит, проверять надо не то, как он выглядит, — это
// дело publicId.test, — а ровно те два обещания, ради которых он оставлен:
// одинаковый аккаунт всегда даёт одинаковую ссылку, и рядом с ней читается
// дата заведения.
const mockProfiles: { id: number; did: string; createdAt: number }[] = [];
const mockActive = { id: 1 };

jest.mock('../profileManager', () => ({
  profileManager: {
    getAllProfiles: () => mockProfiles,
    getActiveProfile: () => mockProfiles.find((p) => p.id === mockActive.id) ?? null,
  },
}));

const DID_A = 'did:key:z6MkvMHxVsrnyccHiUmVw2MAQXexvXsEyTyS4sTCLy785nLm';
const DID_B = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

beforeEach(() => {
  mockProfiles.length = 0;
  mockProfiles.push({ id: 1, did: DID_A, createdAt: 1_700_000_000_000 });
  mockProfiles.push({ id: 2, did: DID_B, createdAt: 1_750_000_000_000 });
  mockActive.id = 1;
});

describe('accountRefFor', () => {
  it('ссылка выводится из ключа и не зависит ни от чего другого', () => {
    expect(accountRefFor(DID_A)).toBe(publicIdFor('account', DID_A));
    expect(accountRefFor(DID_A)).toMatch(/^AC-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(accountRefFor(DID_A)).not.toBe(accountRefFor(DID_B));
  });

  it('без DID ссылки нет', () => {
    expect(accountRefFor('')).toBe('');
    expect(accountRefFor(null)).toBe('');
    expect(accountRefFor(undefined)).toBe('');
  });
});

describe('своя ссылка', () => {
  it('отдаётся вместе с датой заведения аккаунта', () => {
    expect(ownAccountRefInfo()).toEqual({
      ref: accountRefFor(DID_A),
      did: DID_A,
      createdAt: 1_700_000_000_000,
    });
    expect(ownAccountRef()).toBe(accountRefFor(DID_A));
  });

  it('переключение аккаунта меняет и ссылку, и дату', () => {
    mockActive.id = 2;
    expect(ownAccountRefInfo()).toEqual({
      ref: accountRefFor(DID_B),
      did: DID_B,
      createdAt: 1_750_000_000_000,
    });
  });

  it('до создания профиля ссылки нет, но и падения нет', () => {
    mockProfiles.length = 0;
    expect(ownAccountRefInfo()).toBeNull();
    expect(ownAccountRef()).toBe('');
  });
});

describe('accountRefInfoFor', () => {
  it('читает названный профиль, а не активный', () => {
    expect(accountRefInfoFor(2)?.did).toBe(DID_B);
  });

  it('несуществующий профиль — null', () => {
    expect(accountRefInfoFor(9)).toBeNull();
  });
});

describe('readAccountRef', () => {
  it('принимает набранное руками: регистр, пробелы, путаницу нуля с буквой', () => {
    const ref = accountRefFor(DID_A);
    expect(readAccountRef(ref.toLowerCase())).toBe(ref);
    expect(readAccountRef(` ${ref} `)).toBe(ref);
  });

  it('группу и канал за аккаунт не принимает', () => {
    // Реф-код группы, поданный боту вместо аккаунта, — это молча неверный
    // ответ, а не ошибка ввода: ловить его надо здесь.
    expect(readAccountRef(publicIdFor('group', 'g-1'))).toBeNull();
    expect(readAccountRef(publicIdFor('channel', 'c-1'))).toBeNull();
    expect(isAccountRef(publicIdFor('group', 'g-1'))).toBe(false);
  });

  it('мусор отвергается', () => {
    for (const bad of ['', 'AC-', 'AC-1234-12345', 'hello', 42, null, undefined, {}]) {
      expect(readAccountRef(bad)).toBeNull();
    }
    expect(isAccountRef(accountRefFor(DID_A))).toBe(true);
  });
});
