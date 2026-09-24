/**
 * v4.32.879. Окно пересылки говорило «Нет контактов» вместо всего сразу.
 *
 * Дефект. Список читался двумя вызовами без `catch`
 * (`void listContacts().then(setContacts)`), и отказ базы никуда не попадал:
 * состояние оставалось пустым, а пустому списку полагалась одна-единственная
 * надпись — «Нет контактов». Та же надпись висела, пока список ещё читается, и
 * когда поиск ничего не нашёл.
 *
 * Цена. Сбой чтения выглядел как приговор: переслать некому. Человек закрывал
 * окно и искал другой способ, хотя чаты были на месте, а помогло бы повторить.
 * Повторить, впрочем, было нечем: чтение запускалось один раз на открытие.
 *
 * Правка. Одно чтение на оба списка, с `catch`. Пустота разбирается на четыре
 * разных случая (forwardEmptyKind), отказ называется словами и по нажатию
 * читает список заново.
 */
import fs from 'fs';
import path from 'path';
import {
  FWD_EMPTY_TEXT,
  FWD_FAILED_TEXT,
  FWD_LOADING_TEXT,
  FWD_NOT_FOUND_TEXT,
  forwardEmptyKind,
  forwardEmptyText,
} from '../forwardListState';

const DIR = path.join(__dirname, '..');
const read = (name: string): string => fs.readFileSync(path.join(DIR, name), 'utf8');
/** Код без комментариев: слова из докблоков не должны считаться за проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.trim() ? l : ' ')).join('\n');

describe('v4.32.879 — пустота в окне пересылки', () => {
  describe('ПРОВЕРКА НЕ ПУСТАЯ (проходит и на старом коде)', () => {
    it('окно пересылки на месте и рисует надпись для пустого списка', () => {
      const src = codeOnly(read('ChatForwardModal.tsx'));
      expect(src).toContain('export function ForwardModal(');
      expect(src).toContain('ListEmptyComponent={');
      expect(src).toContain('fwdStyles.empty');
    });

    it('список и правда собирается из контактов и групп', () => {
      const src = codeOnly(read('ChatForwardModal.tsx'));
      expect(src).toContain('listContacts()');
      expect(src).toContain('listGroups(pid)');
      expect(src).toContain('const listData: FwdItem[] = [');
    });
  });

  describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
    it('чтение контактов и групп — обращение к базе, которое может отказать', () => {
      const contacts = fs.readFileSync(path.join(DIR, '../../../../core/social/contacts.ts'), 'utf8');
      expect(contacts).toMatch(/export async function listContacts\(/);
      const local = fs.readFileSync(path.join(DIR, '../../../../core/storage/local.ts'), 'utf8');
      expect(local).toMatch(/export async function listGroups\(/);
    });
  });

  describe('разбор пустоты', () => {
    it('пока читается — так и говорим', () => {
      expect(forwardEmptyKind('loading', false, '')).toBe('loading');
      expect(forwardEmptyText('loading')).toBe(FWD_LOADING_TEXT);
    });

    it('отказ важнее всего остального, включая поиск', () => {
      expect(forwardEmptyKind('failed', false, '')).toBe('failed');
      expect(forwardEmptyKind('failed', true, 'аня')).toBe('failed');
      expect(forwardEmptyText('failed')).toBe(FWD_FAILED_TEXT);
      expect(FWD_FAILED_TEXT).toContain('повторить');
    });

    it('чаты есть, но поиск ничего не нашёл — это не «переслать некому»', () => {
      expect(forwardEmptyKind('ready', true, 'аня')).toBe('not-found');
      expect(forwardEmptyText('not-found')).toBe(FWD_NOT_FOUND_TEXT);
    });

    it('пробелы в поиске за поиск не считаются', () => {
      expect(forwardEmptyKind('ready', true, '   ')).toBe('empty');
    });

    it('чатов нет вовсе — единственный случай, где прежняя надпись была правдой', () => {
      expect(forwardEmptyKind('ready', false, '')).toBe('empty');
      expect(forwardEmptyKind('ready', false, 'аня')).toBe('empty');
      expect(forwardEmptyText('empty')).toBe(FWD_EMPTY_TEXT);
    });

    it('все четыре надписи разные', () => {
      const all = [FWD_LOADING_TEXT, FWD_FAILED_TEXT, FWD_NOT_FOUND_TEXT, FWD_EMPTY_TEXT];
      expect(new Set(all).size).toBe(4);
      for (const t of all) expect(t.trim().length).toBeGreaterThan(0);
    });
  });

  describe('окно пересылки пользуется разбором', () => {
    const src = codeOnly(read('ChatForwardModal.tsx'));

    it('прежняя единственная надпись убрана', () => {
      expect(src).not.toContain('Нет контактов');
    });

    it('чтение одно на оба списка и с перехватом отказа', () => {
      expect(src).toContain('void Promise.all([listContacts(), listGroups(pid)])');
      expect(src).toContain(".catch((e) => {");
      expect(src).toContain("setLoad('failed')");
      expect(src).not.toContain('void listContacts().then(setContacts)');
    });

    it('надпись выбирается разбором, а отказ даёт повтор', () => {
      expect(src).toContain('forwardEmptyKind(load, contacts.length + groups.length > 0, fwdSearch)');
      expect(src).toContain('forwardEmptyText(kind)');
      expect(src).toContain('setAttempt((n) => n + 1)');
      expect(src).toContain('[visible, pid, attempt]');
    });

    it('закрытое окно не доедает свой ответ', () => {
      expect(src).toContain('let alive = true;');
      expect(src).toContain('return () => { alive = false; };');
    });
  });
});
