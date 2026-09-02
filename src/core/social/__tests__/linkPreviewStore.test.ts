/**
 * Рэтчет к v4.32.540 — память о предпросмотрах ссылок.
 *
 * Главное, за чем следит этот файл: отмена загрузки не должна становиться
 * приговором адресу. Именно так дефект и выглядел — карточка исчезала не
 * из-за сайта, а из-за того, что человек пролистнул переписку быстрее, чем за
 * шесть секунд, и до перезапуска приложения не возвращалась нигде.
 */
import fs from 'fs';
import path from 'path';

import {
  LINK_PREVIEW_MAX_BYTES,
  createLinkPreviewStore,
  tooLargeToRead,
  type LinkPreviewCard,
} from '../linkPreviewStore';

// v4.32.534: карточка уехала из ChatScreen.tsx в свой модуль — экран диалога
// раздавал её группам и ленте как бочка ре-экспортов. Проверки те же.
const CHAT = fs.readFileSync(
  path.join(__dirname, '../../../ui/screens/chat-components/LinkPreview.tsx'),
  'utf8',
);

const card = (title: string): LinkPreviewCard => ({
  title,
  description: '',
  domain: 'example.org',
  image: null,
});

describe('linkPreviewStore: что известно про адрес', () => {
  it('незнакомый адрес неизвестен и достоин запроса', () => {
    const s = createLinkPreviewStore();
    expect(s.get('u')).toEqual({ kind: 'unknown' });
    expect(s.shouldFetch('u')).toBe(true);
  });

  it('прочитанная страница отдаёт карточку и больше не запрашивается', () => {
    const s = createLinkPreviewStore();
    s.remember('u', card('Заголовок'));
    expect(s.get('u')).toEqual({ kind: 'card', card: card('Заголовок') });
    expect(s.shouldFetch('u')).toBe(false);
  });

  it('страница без заголовка — это «нечего показывать», а не «неизвестно»', () => {
    const s = createLinkPreviewStore();
    s.remember('u', null);
    expect(s.get('u')).toEqual({ kind: 'none' });
    expect(s.shouldFetch('u')).toBe(false);
  });

  it('забытый адрес спрашивается заново — настройку приватности могли включить', () => {
    const s = createLinkPreviewStore();
    s.remember('u', null);
    s.forget('u');
    expect(s.shouldFetch('u')).toBe(true);
  });
});

describe('linkPreviewStore: неудачи считаются попытками', () => {
  it('одна неудача не закрывает вопрос', () => {
    const s = createLinkPreviewStore(10, 3);
    expect(s.noteFailure('u')).toBe(false);
    expect(s.shouldFetch('u')).toBe(true);
    expect(s.get('u')).toEqual({ kind: 'unknown' });
  });

  it('попытки кончаются — адрес считается пустым и сеть больше не тревожится', () => {
    const s = createLinkPreviewStore(10, 3);
    expect(s.noteFailure('u')).toBe(false);
    expect(s.noteFailure('u')).toBe(false);
    expect(s.noteFailure('u')).toBe(true);
    expect(s.shouldFetch('u')).toBe(false);
    expect(s.get('u')).toEqual({ kind: 'none' });
  });

  it('удачная загрузка обнуляет счёт неудач', () => {
    const s = createLinkPreviewStore(10, 3);
    s.noteFailure('u');
    s.noteFailure('u');
    s.remember('u', card('Есть'));
    expect(s.get('u')).toEqual({ kind: 'card', card: card('Есть') });
  });

  it('неудача не портит уже полученную карточку', () => {
    const s = createLinkPreviewStore(10, 3);
    s.remember('u', card('Есть'));
    expect(s.noteFailure('u')).toBe(true);
    expect(s.get('u')).toEqual({ kind: 'card', card: card('Есть') });
  });

  it('счёт попыток ведётся по каждому адресу отдельно', () => {
    const s = createLinkPreviewStore(10, 2);
    s.noteFailure('a');
    expect(s.noteFailure('b')).toBe(false);
    expect(s.shouldFetch('b')).toBe(true);
  });

  it('нелепые пределы заменяются разумными, а не отключают память', () => {
    const s = createLinkPreviewStore(0, 0);
    s.remember('u', card('Есть'));
    expect(s.get('u').kind).toBe('card');
    expect(s.noteFailure('x')).toBe(false);
  });
});

describe('linkPreviewStore: память не растёт бесконечно', () => {
  it('старое вытесняется при переполнении', () => {
    const s = createLinkPreviewStore(2, 3);
    s.remember('a', card('A'));
    s.remember('b', card('B'));
    s.remember('c', card('C'));
    expect(s.size()).toBe(2);
    expect(s.get('a').kind).toBe('unknown');
    expect(s.get('c').kind).toBe('card');
  });

  it('обращение освежает запись: вытесняется то, к чему давно не обращались', () => {
    const s = createLinkPreviewStore(2, 3);
    s.remember('a', card('A'));
    s.remember('b', card('B'));
    s.get('a');
    s.remember('c', card('C'));
    expect(s.get('a').kind).toBe('card');
    expect(s.get('b').kind).toBe('unknown');
  });

  it('неудачи тоже не копятся сверх предела', () => {
    const s = createLinkPreviewStore(2, 5);
    s.noteFailure('a');
    s.noteFailure('b');
    s.noteFailure('c');
    expect(s.size()).toBe(2);
  });

  it('повторная запись того же адреса не раздувает память', () => {
    const s = createLinkPreviewStore(5, 3);
    s.remember('u', card('1'));
    s.remember('u', card('2'));
    expect(s.size()).toBe(1);
  });
});

describe('linkPreviewStore: предел размера страницы', () => {
  it('заявленный размер сверх предела читать не стоит', () => {
    expect(tooLargeToRead(String(LINK_PREVIEW_MAX_BYTES + 1))).toBe(true);
  });

  it('ровно предел читается', () => {
    expect(tooLargeToRead(String(LINK_PREVIEW_MAX_BYTES))).toBe(false);
  });

  it('отсутствующий и нечисловой заголовок не считаются превышением', () => {
    expect(tooLargeToRead(null)).toBe(false);
    expect(tooLargeToRead(undefined)).toBe(false);
    expect(tooLargeToRead('много')).toBe(false);
    expect(tooLargeToRead('-5')).toBe(false);
  });
});

describe('карточка ссылки: модуль LinkPreview', () => {
  it('голой Map больше нет', () => {
    expect(CHAT).not.toContain('const previewCache = new Map<');
    expect(CHAT).not.toContain('previewCache.set(');
    expect(CHAT).not.toContain('previewCache.has(');
  });

  it('решение «идти ли в сеть» принимает хранилище', () => {
    expect(CHAT).toContain('previewStore.shouldFetch(url)');
    expect(CHAT).toContain('const previewStore = createLinkPreviewStore();');
  });

  it('отмена не записывается в память', () => {
    const from = CHAT.indexOf('      } catch {\n        // Отмена');
    expect(from).toBeGreaterThan(-1);
    const block = CHAT.slice(from, from + 700);
    expect(block).toContain('if (cancelled) return;');
    expect(block).toContain('previewStore.noteFailure(url)');
    // Прежняя строка приговора: она и делала ссылку пустой навсегда.
    expect(block).not.toContain('previewStore.remember(url, null)');
  });

  it('ответ не-200 и слишком большая страница запоминаются как «нечего показывать»', () => {
    expect(CHAT).toContain('if (!res.ok) {');
    expect(CHAT).toContain("tooLargeToRead(res.headers.get('content-length'))");
    expect(CHAT).not.toContain('if (!res.ok || cancelled) return;');
  });

  it('состояние карточки поднимается из памяти при первом появлении', () => {
    expect(CHAT).toContain("known.kind === 'card' ? known.card : known.kind === 'none' ? null : undefined");
  });
});
