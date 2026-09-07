/**
 * Имя в тексте — не адрес. Превратить его в ключ можно только по адресной
 * книге, и здесь проверяется, что превращение честное: username сильнее имени,
 * а два одинаковых имени дают отказ, а не первого попавшегося (v4.32.605).
 */
import { lookupMentionAmong, contactCandidates } from '../mentionLookup';
import type { Contact } from '../contacts';

function contact(p: Partial<Contact> & { peerPublicKey: string }): Contact {
  return { displayName: '', ...p };
}

const ivan = contact({ peerPublicKey: 'PUB_IVAN', displayName: 'Иван Петров', peerUsername: 'ivan' });
const ivan2 = contact({ peerPublicKey: 'PUB_IVAN2', displayName: 'Иван Петров', peerUsername: 'petrov' });
const rita = contact({ peerPublicKey: 'PUB_RITA', displayName: '', peerName: 'Рита' });

describe('поиск упомянутого в адресной книге', () => {
  it('username находит контакт независимо от регистра', () => {
    expect(lookupMentionAmong('IVAN', [ivan, ivan2])).toEqual({
      status: 'found',
      peerPubB64: 'PUB_IVAN',
      displayName: 'Иван Петров',
    });
  });

  it('username сильнее имени: «petrov» — это второй Иван', () => {
    expect(lookupMentionAmong('petrov', [ivan, ivan2])).toEqual({
      status: 'found',
      peerPubB64: 'PUB_IVAN2',
      displayName: 'Иван Петров',
    });
  });

  it('одно имя на двоих — отказ, а не догадка', () => {
    expect(lookupMentionAmong('Иван', [ivan, ivan2])).toEqual({ status: 'ambiguous' });
  });

  it('первое слово имени находит единственного носителя', () => {
    expect(lookupMentionAmong('Иван', [ivan])).toEqual({
      status: 'found',
      peerPubB64: 'PUB_IVAN',
      displayName: 'Иван Петров',
    });
  });

  it('самоназвание тоже ищется, когда местной подписи нет', () => {
    expect(lookupMentionAmong('Рита', [rita])).toEqual({
      status: 'found',
      peerPubB64: 'PUB_RITA',
      displayName: 'Рита',
    });
  });

  it('незнакомое имя не находится', () => {
    expect(lookupMentionAmong('Пётр', [ivan, rita])).toEqual({ status: 'none' });
    expect(lookupMentionAmong('', [ivan])).toEqual({ status: 'none' });
  });

  it('два имени одного контакта не делают его двумя людьми', () => {
    const both = contact({ peerPublicKey: 'PUB_X', displayName: 'Кот', peerName: 'Кот' });
    expect(contactCandidates([both])).toHaveLength(1);
    const renamed = contact({ peerPublicKey: 'PUB_Y', displayName: 'Сосед', peerName: 'Аркадий' });
    expect(contactCandidates([renamed])).toHaveLength(2);
    expect(lookupMentionAmong('Аркадий', [renamed])).toEqual({
      status: 'found',
      peerPubB64: 'PUB_Y',
      displayName: 'Сосед',
    });
  });
});

describe('чужой username не открывает чужую карточку', () => {
  const alice = contact({ peerPublicKey: 'PUB_ALICE', displayName: 'Алиса', peerUsername: 'alice' });
  const mallory = contact({ peerPublicKey: 'PUB_MAL', displayName: 'Мэллори', peerUsername: 'ALICE' });

  it('двое назвались одним именем — отказ, а не первый попавшийся', () => {
    expect(lookupMentionAmong('@alice', [alice, mallory])).toEqual({ status: 'ambiguous' });
    expect(lookupMentionAmong('@alice', [mallory, alice])).toEqual({ status: 'ambiguous' });
  });

  it('один носитель имени находится как прежде', () => {
    expect(lookupMentionAmong('@alice', [alice])).toEqual({
      status: 'found',
      peerPubB64: 'PUB_ALICE',
      displayName: 'Алиса',
    });
  });

  it('две строки одного контакта неоднозначности не создают', () => {
    const two = contact({
      peerPublicKey: 'PUB_ONE',
      displayName: 'Своя подпись',
      peerName: 'Самоназвание',
      peerUsername: 'one',
    });
    expect(contactCandidates([two])).toHaveLength(2);
    expect(lookupMentionAmong('@one', [two])).toEqual({
      status: 'found',
      peerPubB64: 'PUB_ONE',
      displayName: 'Своя подпись',
    });
  });
});
