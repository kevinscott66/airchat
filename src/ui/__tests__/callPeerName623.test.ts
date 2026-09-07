/**
 * Звонок из карточки собеседника подписывается его именем (v4.32.623).
 *
 * Второй параметр `initiateCall` — имя СОБЕСЕДНИКА: оно ложится в строку
 * звонка на экране и в журнал звонков (callService.recordCallEnd). Из карточки
 * туда подставлялось СВОЁ имя (`getOwnDisplayName()`), и в журнале исходящих
 * все звонки подряд оказывались от самого себя.
 *
 * Проверяется форма исходника: UserProfilePeek тянет за собой половину
 * приложения, а разница между своим и чужим именем видна прямо в вызове.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'UserProfilePeek.tsx'),
  'utf8',
);

/** Тело startCall без строк-комментариев: в них имя правки упомянуто нарочно. */
function startCall(): string {
  const from = SRC.indexOf('const startCall = useCallback((video: boolean) => {');
  expect(from).toBeGreaterThan(0);
  const to = SRC.indexOf('const toggleMute = useCallback(', from);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

it('в звонок уходит имя собеседника, а не своё', () => {
  const body = startCall();
  expect(body).toContain('await initiateCall(resolved.pubB64, displayName, video)');
  expect(body).not.toContain('getOwnDisplayName');
  // displayName пришло извне колбэка — без него в зависимостях он застынет на
  // имени, которое было при первом рисовании, и переименование не доедет.
  expect(body).toContain('}, [resolved, displayName, onClose]);');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: то же имя уже открывает переписку, и своё имя в файле есть', () => {
  expect(SRC).toContain('onOpenChat?.(resolved.pubB64, displayName)');
  expect(SRC).toContain('const displayName = identity.contactName;');
  // Своё имя из файла не пропало — оно по-прежнему нужно карточке в другом месте.
  expect(SRC).toContain('getOwnDisplayName(),');
});
