/**
 * Предпросмотр ссылки — это запрос, который приложение делает само, без
 * действия пользователя. Для чужой ссылки это маяк: отправитель получает
 * IP-адрес получателя и момент показа переписки. Проверяем, что по умолчанию
 * такие ссылки не загружаются, а свои — загружаются всегда.
 */

import {
  LINK_PREVIEW_INCOMING_KEY,
  parseIncomingLinkPreviewPref,
  shouldLoadLinkPreview,
} from '../linkPreviewPolicy';

describe('parseIncomingLinkPreviewPref', () => {
  it('включено только при явном "true"', () => {
    expect(parseIncomingLinkPreviewPref('true')).toBe(true);
  });

  it('пустая настройка — выключено (безопасное умолчание)', () => {
    for (const raw of [null, undefined, '', 'false']) {
      expect(parseIncomingLinkPreviewPref(raw)).toBe(false);
    }
  });

  it('мусор в хранилище не включает загрузку', () => {
    for (const raw of ['TRUE', 'True', '1', 'yes', 'да', ' true', 'true ', '{"v":true}']) {
      expect(parseIncomingLinkPreviewPref(raw)).toBe(false);
    }
  });

  it('ключ настройки не меняется — иначе выбор пользователя потеряется', () => {
    expect(LINK_PREVIEW_INCOMING_KEY).toBe('privacy_link_preview_incoming');
  });
});

describe('shouldLoadLinkPreview', () => {
  it('свою ссылку грузим независимо от настройки', () => {
    expect(shouldLoadLinkPreview(false, false)).toBe(true);
    expect(shouldLoadLinkPreview(false, true)).toBe(true);
  });

  it('чужую ссылку по умолчанию не грузим', () => {
    expect(shouldLoadLinkPreview(true, false)).toBe(false);
  });

  it('чужую ссылку грузим только после осознанного включения', () => {
    expect(shouldLoadLinkPreview(true, true)).toBe(true);
  });

  it('сквозная проверка: пустое хранилище + входящая ссылка = запроса нет', () => {
    expect(shouldLoadLinkPreview(true, parseIncomingLinkPreviewPref(null))).toBe(false);
  });
});
