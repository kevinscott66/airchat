/**
 * Номер профиля по ключу, которым работает служба (v4.32.482).
 *
 * Правило «профиль ищется по ключу, а не по тому, что открыто на экране»
 * живёт в ownerPidByDid — там оно чистое и проверяется без базы. Но проводка
 * этого правила к profileManager успела разойтись копиями: одна в messaging,
 * вторая в storyService, третья просилась в presence. Разъехавшиеся копии
 * одного правила про личность нам уже дорого обходились, поэтому проводка
 * одна и живёт здесь.
 *
 * Ответ по умолчанию — 1: на установке без seed профилей нет вовсе, и там
 * единственный номер верен.
 */
import { profileManager } from './profileManager';
import { ownerPidByDid } from './ownerProfile';
import { publicKeyToDidKey } from './did';
import { publicKeyFromB64 } from '../crypto/pubKeyFormat';

/** Профиль, которому принадлежит did. */
export function ownerPidForDid(did: string): number {
  return (
    ownerPidByDid(
      did,
      profileManager.getActiveProfile(),
      () => profileManager.getAllProfiles(),
    ) ?? 1
  );
}

/** Профиль, которому принадлежит открытый ключ. */
export function ownerPidForPublicKey(publicKey: Uint8Array): number {
  return ownerPidForDid(publicKeyToDidKey(publicKey));
}

/**
 * Профиль по ключу в записи base64, либо null.
 *
 * Разбор — через pubKeyFormat: разбирать ключ из base64 своими руками нельзя,
 * `Buffer.from` молча выбрасывает недопустимые символы и отдаёт «ключ» той же
 * длины. Строка не оказалась ключом — профиль не назван, и вызывающий обязан
 * решить это сам, а не получить единицу под видом ответа.
 */
export function ownerPidForPublicKeyB64(value: string): number | null {
  const publicKey = publicKeyFromB64(value);
  return publicKey ? ownerPidForPublicKey(publicKey) : null;
}
