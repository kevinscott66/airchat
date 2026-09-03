import React from 'react';
import { PersonAvatar } from '../../components/PersonAvatar';

/**
 * Кружок отправителя в групповой переписке.
 *
 * v4.32.565: рисование переехало в PersonAvatar — он показывает снимок
 * участника, если тот известен, и тот же кружок с буквой, если нет. Отдельный
 * компонент остаётся ради отступа справа и общего для группы размера.
 *
 * v4.32.399: `seed` отделён от `name` намеренно. Цвет должен держаться за
 * человека, а не за подпись: имя участник меняет, и с прежним выводом «тон из
 * имени» вместе с ним менялся цвет — причём только здесь, потому что в списке
 * участников тот же кружок выводился из ключа.
 */
export function GrpSenderAvatar({ name, seed, size = 28 }: { name: string; seed: string; size?: number }): React.ReactElement {
  return <PersonAvatar pub={seed} name={name} size={size} style={{ marginRight: 6, flexShrink: 0 }} />;
}
