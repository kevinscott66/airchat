import { isUserFacingMessage, rawErrorText, userErrorText } from '../userErrorText';

/**
 * Правило одно: наш текст (кириллица) уходит на экран как есть, чужой —
 * заменяется. Проверяем обе стороны, иначе тест докажет только половину.
 */
describe('userErrorText', () => {
  it('пропускает наш собственный русский текст', () => {
    expect(userErrorText(new Error('Комментарий пустой'), 'запас')).toBe('Комментарий пустой');
    expect(userErrorText(new Error('Неверный пароль или повреждённая резервная копия.'), 'запас'))
      .toBe('Неверный пароль или повреждённая резервная копия.');
  });

  it('заменяет наши собственные машинные опознаватели', () => {
    // Ровно эти строки бросает src/core и ровно их читал человек до v4.32.428.
    for (const id of [
      'invalid_send_at',
      'send_at_out_of_range',
      'invalid_text_length',
      'no_pc',
      'feed_storage_profile_unset',
      'lan_sender_did_too_long',
      'invite_token_bad_random',
      'documentDirectory unavailable',
      'Invalid seed phrase',
      'Profile manager not ready',
    ]) {
      expect(userErrorText(new Error(id), 'Не удалось отправить')).toBe('Не удалось отправить');
    }
  });

  it('заменяет тексты чужих библиотек', () => {
    expect(userErrorText(new Error('Network request failed'), 'Нет связи')).toBe('Нет связи');
    expect(userErrorText(new Error('"point" expected Uint8Array of length 32, got length=10'), 'Ключ испорчен'))
      .toBe('Ключ испорчен');
  });

  it('на не-Error отдаёт запасной текст, а не [object Object]', () => {
    expect(userErrorText({ message: 'Не удалось' }, 'Не получилось')).toBe('Не получилось');
    expect(userErrorText(null, 'Не получилось')).toBe('Не получилось');
    expect(userErrorText(undefined, 'Не получилось')).toBe('Не получилось');
    expect(userErrorText('Строку у нас не бросают', 'Не получилось')).toBe('Не получилось');
  });

  it('не пускает на экран пустое сообщение', () => {
    expect(userErrorText(new Error(''), 'Не получилось')).toBe('Не получилось');
    expect(userErrorText(new Error('   '), 'Не получилось')).toBe('Не получилось');
  });

  it('не пускает на экран многострочный дамп, даже с кириллицей', () => {
    expect(userErrorText(new Error('Ошибка\n  at foo (bar.js:1)'), 'Не получилось')).toBe('Не получилось');
  });

  it('не пускает на экран слишком длинный текст, даже с кириллицей', () => {
    const long = `Ошибка: ${'я'.repeat(200)}`;
    expect(userErrorText(new Error(long), 'Не получилось')).toBe('Не получилось');
    // Граница: 160 символов ещё проходят.
    expect(userErrorText(new Error('я'.repeat(160)), 'Не получилось')).toBe('я'.repeat(160));
    expect(userErrorText(new Error('я'.repeat(161)), 'Не получилось')).toBe('Не получилось');
  });

  it('обрезает пробелы по краям нашего текста', () => {
    expect(userErrorText(new Error('  Комментарий пустой  '), 'запас')).toBe('Комментарий пустой');
  });

  it('пропускает тексты проверки опроса — их пишут для человека', () => {
    // Эти строки бросает pollEnvelope.ts и они ДОЛЖНЫ доходить до экрана:
    // без них человек не узнает, что именно не так с его опросом.
    for (const text of [
      'Вопрос не может быть пустым',
      'Нужно минимум 2 варианта ответа',
      'Слишком много вариантов (макс. 12)',
      'Вопрос слишком длинный (макс. 256 символов)',
    ]) {
      expect(userErrorText(new Error(text), 'запас')).toBe(text);
    }
  });
});

describe('isUserFacingMessage', () => {
  it('различает наш текст и чужой', () => {
    expect(isUserFacingMessage('Не удалось')).toBe(true);
    expect(isUserFacingMessage('Failed')).toBe(false);
    expect(isUserFacingMessage('')).toBe(false);
    // Ёё — тоже кириллица, и в наших текстах она встречается («ещё», «удалён»).
    expect(isUserFacingMessage('Профиль удалён')).toBe(true);
    expect(isUserFacingMessage('Попробуйте ещё раз')).toBe(true);
  });
});

describe('rawErrorText', () => {
  it('отдаёт сообщение Error как есть', () => {
    expect(rawErrorText(new Error('invalid_send_at'))).toBe('invalid_send_at');
  });

  it('не теряет факт падения на не-Error', () => {
    expect(rawErrorText(null)).toBe('null');
    expect(rawErrorText(42)).toBe('42');
    expect(rawErrorText({})).toBe('[object Object]');
  });

  it('обрезает многомегабайтный текст, чтобы не забить журнал', () => {
    const out = rawErrorText(new Error('x'.repeat(10_000)));
    expect(out.length).toBe(501);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  it('короткий текст не трогает', () => {
    expect(rawErrorText(new Error('x'.repeat(500)))).toBe('x'.repeat(500));
  });
});
