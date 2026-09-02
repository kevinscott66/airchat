/**
 * Кольцо фокуса для веб-порта.
 *
 * react-native-web отдаёт TextInput как <input>, и Chrome рисует ему свой
 * системный контур — жёлто-оранжевый, вне палитры и вне геометрии 4.32.531.
 * Токена «фокус» в теме нет намеренно: на нативе фокус рисует система, так что
 * правило живёт здесь, в единственном месте, где оно применимо, и берёт цвет
 * из тех же `accent`, что и остальной интерфейс.
 *
 * `:focus-visible`, а не `:focus`: кольцо нужно клавиатуре, а не мыши.
 */
import { darkColors, lightColors, radius } from './theme';

const STYLE_ID = 'airchat-focus-ring';

const CSS = `
:focus { outline: none; }
:focus-visible {
  outline: 2px solid ${darkColors.accent};
  outline-offset: 2px;
  border-radius: ${radius.sm}px;
}
@media (prefers-color-scheme: light) {
  :focus-visible { outline-color: ${lightColors.accent}; }
}
`;

export function installWebFocusRing(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID) != null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
