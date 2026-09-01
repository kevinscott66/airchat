import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ru from './ru.json';

void i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru } },
  lng: 'ru',
  fallbackLng: 'ru',
  compatibilityJSON: 'v4',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
