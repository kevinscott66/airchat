/**
 * Публикация по ссылке, копирование и отзыв ссылки — без экрана (AC-04, AC-17).
 *
 * Копия записи для ссылки лежит на сервере НЕ зашифрованной: у ссылки нет
 * получателя, чьим ключом её можно было бы закрыть. Значит, её читает сервер и
 * любой, к кому попала ссылка. Отсюда правила, которые этот модуль держит:
 *
 * 1. Наружу запись уходит только после явного «Опубликовать» в диалоге. Отмена
 *    диалога не создаёт копию. «Копировать ссылку» и «Поделиться» на ещё не
 *    опубликованной записи ведут через тот же диалог — скрыто ничего не
 *    выкладывается.
 * 2. Ссылка отдаётся (буфер обмена, лист «поделиться») только ПОСЛЕ того, как
 *    сервер принял копию. Отказ — ошибка, и ничего не скопировано и не отдано:
 *    раньше «скопировано» показывалось раньше ответа сервера, и получатель
 *    открывал нерабочую ссылку.
 * 3. На одну запись идёт одно действие за раз: второе нажатие, пока первое ещё
 *    идёт, не запускает вторую публикацию (конверт с фото — до двух мегабайт).
 * 4. Уже опубликованная запись при копировании ссылки никуда заново не
 *    уходит, а чужая или запись без облака — не публикуется вовсе: ссылка на
 *    неё откроется лишь у тех, у кого запись уже есть, и об этом говорится.
 *
 * Здесь нет ни React, ни React Native: всё внешнее приходит зависимостями,
 * поэтому поток проверяется поведенческими тестами (см. __tests__/postLinkFlow).
 */

/** Что знает о записи вызывающий. */
export interface PostLinkTarget {
  postId: string;
  /** Своя ли запись: чужую подписать нечем, выложить её нельзя. */
  own: boolean;
  /** Опубликована ли уже по ссылке (по отметке устройства). */
  published: boolean;
}

export interface PostLinkFlowDeps {
  /** Настроено ли облако, куда кладётся копия. */
  canPublish: () => boolean;
  /** Диалог «Опубликовать по ссылке?». `true` — человек подтвердил. */
  confirmPublish: () => Promise<boolean>;
  /** Диалог «Отозвать ссылку?». */
  confirmRevoke: () => Promise<boolean>;
  /** Положить копию на сервер. `true` — сервер её принял. */
  publish: (postId: string) => Promise<boolean>;
  /** Снять копию с сервера. `true` — копии там больше нет. */
  revoke: (postId: string) => Promise<boolean>;
  copy: (text: string) => Promise<void>;
  share: (message: string) => Promise<void>;
  /** Идёт ли сетевая часть (публикация/отзыв) — для индикатора. */
  onBusyChange?: (postId: string, busy: boolean) => void;
  /** Сменилось состояние «опубликовано по ссылке». */
  onPublishedChange?: (postId: string, published: boolean) => void;
}

/**
 * Чем кончилось копирование или «поделиться».
 *
 * - `done` — ссылка отдана; `reach: 'public'` — откроется у любого, у кого она
 *   есть, `'local'` — только у тех, у кого запись уже есть. `justPublished` —
 *   запись выложена именно этим нажатием.
 * - `cancelled` — человек не подтвердил публикацию; ничего не выложено и не
 *   отдано.
 * - `publishFailed` — сервер копию не принял; ничего не отдано.
 * - `handoffFailed` — копия есть (или не нужна), но буфер обмена или лист
 *   «поделиться» отказали.
 * - `busy` — по этой записи уже идёт действие; второе не запускалось.
 */
export type PostLinkHandoffOutcome =
  | { kind: 'done'; reach: 'public' | 'local'; justPublished: boolean }
  | { kind: 'cancelled' }
  | { kind: 'publishFailed' }
  | { kind: 'handoffFailed' }
  | { kind: 'busy' };

/** Чем кончилось явное «Опубликовать по ссылке». */
export type PostLinkPublishOutcome =
  | 'published'
  | 'alreadyPublished'
  | 'cancelled'
  | 'failed'
  /** Чужая запись или облако не настроено — выложить нечем. */
  | 'unavailable'
  | 'busy';

/** Чем кончилось «Отозвать ссылку». */
export type PostLinkRevokeOutcome = 'revoked' | 'notPublished' | 'cancelled' | 'failed' | 'busy';

export interface PostLinkFlow {
  copyLink: (target: PostLinkTarget, url: string) => Promise<PostLinkHandoffOutcome>;
  shareLink: (target: PostLinkTarget, message: string) => Promise<PostLinkHandoffOutcome>;
  publish: (target: PostLinkTarget) => Promise<PostLinkPublishOutcome>;
  revoke: (target: PostLinkTarget) => Promise<PostLinkRevokeOutcome>;
  isBusy: (postId: string) => boolean;
}

/** Можно ли эту запись вообще выложить по ссылке. */
export function mayPublishByLink(target: PostLinkTarget, deps: Pick<PostLinkFlowDeps, 'canPublish'>): boolean {
  return target.own && deps.canPublish();
}

export function createPostLinkFlow(deps: PostLinkFlowDeps): PostLinkFlow {
  /** Записи, по которым действие уже идёт (включая открытый диалог). */
  const inFlight = new Set<string>();

  async function locked<T>(postId: string, busy: T, run: () => Promise<T>): Promise<T> {
    if (inFlight.has(postId)) return busy;
    inFlight.add(postId);
    try {
      return await run();
    } finally {
      inFlight.delete(postId);
    }
  }

  /** Сетевая часть: индикатор горит ровно пока идёт запрос. */
  async function network(postId: string, run: () => Promise<boolean>): Promise<boolean> {
    deps.onBusyChange?.(postId, true);
    try {
      return await run();
    } catch {
      return false;
    } finally {
      deps.onBusyChange?.(postId, false);
    }
  }

  /**
   * Довести запись до состояния, в котором ссылку можно отдавать.
   * `public`/`local` — можно (и насколько широко она откроется).
   */
  async function prepare(
    target: PostLinkTarget,
  ): Promise<{ kind: 'ready'; reach: 'public' | 'local'; justPublished: boolean } | { kind: 'cancelled' } | { kind: 'publishFailed' }> {
    if (!mayPublishByLink(target, deps)) return { kind: 'ready', reach: 'local', justPublished: false };
    if (target.published) return { kind: 'ready', reach: 'public', justPublished: false };
    if (!(await deps.confirmPublish())) return { kind: 'cancelled' };
    const ok = await network(target.postId, () => deps.publish(target.postId));
    if (!ok) return { kind: 'publishFailed' };
    deps.onPublishedChange?.(target.postId, true);
    return { kind: 'ready', reach: 'public', justPublished: true };
  }

  async function handOff(
    target: PostLinkTarget,
    give: () => Promise<void>,
  ): Promise<PostLinkHandoffOutcome> {
    return locked<PostLinkHandoffOutcome>(target.postId, { kind: 'busy' }, async () => {
      const ready = await prepare(target);
      if (ready.kind !== 'ready') return ready;
      try {
        await give();
      } catch {
        return { kind: 'handoffFailed' };
      }
      return { kind: 'done', reach: ready.reach, justPublished: ready.justPublished };
    });
  }

  return {
    copyLink: (target, url) => handOff(target, () => deps.copy(url)),
    shareLink: (target, message) => handOff(target, () => deps.share(message)),

    publish: (target) => locked<PostLinkPublishOutcome>(target.postId, 'busy', async () => {
      if (!mayPublishByLink(target, deps)) return 'unavailable';
      if (target.published) return 'alreadyPublished';
      const ready = await prepare(target);
      if (ready.kind === 'cancelled') return 'cancelled';
      if (ready.kind === 'publishFailed') return 'failed';
      return 'published';
    }),

    revoke: (target) => locked<PostLinkRevokeOutcome>(target.postId, 'busy', async () => {
      if (!target.own || !target.published) return 'notPublished';
      if (!(await deps.confirmRevoke())) return 'cancelled';
      const ok = await network(target.postId, () => deps.revoke(target.postId));
      if (!ok) return 'failed';
      deps.onPublishedChange?.(target.postId, false);
      return 'revoked';
    }),

    isBusy: (postId) => inFlight.has(postId),
  };
}
