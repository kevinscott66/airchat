/**
 * Emoji autocomplete + big-emoji detection (D.3.1 extract).
 */

// ─── Emoji autocomplete map ──────────────────────────────────────────────────
const EMOJI_MAP: Record<string, string> = {
  smile: '😊', happy: '😄', laugh: '😂', joy: '😂', grin: '😁', lol: '🤣',
  sad: '😢', cry: '😭', sob: '😭', angry: '😠', rage: '😡', mad: '😤',
  heart: '❤️', love: '❤️', hearts: '💕', heartbeat: '💓', sparkling_heart: '💖',
  fire: '🔥', hot: '🔥', flame: '🔥', cool: '😎', sunglasses: '😎',
  thumbsup: '👍', thumbup: '👍', up: '👍', thumbsdown: '👎', down: '👎',
  clap: '👏', tada: '🎉', party: '🎉', celebrate: '🥳', congrats: '🎊',
  ok: '👌', yes: '✅', no: '❌', check: '✔️', x: '❌',
  star: '⭐', stars: '✨', sparkles: '✨', boom: '💥', explosion: '💥',
  wave: '👋', hi: '👋', bye: '👋', hello: '👋', hand: '✋',
  think: '🤔', thinking: '🤔', hmm: '🤔', facepalm: '🤦', shrug: '🤷',
  eyes: '👀', eye: '👁️', see: '👀', look: '👀', watch: '👀',
  sun: '☀️', moon: '🌙', cloud: '☁️', rain: '🌧️', snow: '❄️',
  dog: '🐶', cat: '🐱', bear: '🐻', panda: '🐼', fox: '🦊',
  pizza: '🍕', burger: '🍔', sushi: '🍣', cake: '🎂', coffee: '☕',
  beer: '🍺', wine: '🍷', cocktail: '🍸', drink: '🥤', water: '💧',
  music: '🎵', note: '🎵', guitar: '🎸', piano: '🎹', dance: '💃',
  car: '🚗', plane: '✈️', rocket: '🚀', train: '🚂', bike: '🚲',
  house: '🏠', home: '🏡', office: '🏢', school: '🏫', hospital: '🏥',
  money: '💰', cash: '💵', coin: '🪙', bank: '🏦', gem: '💎',
  book: '📚', read: '📖', write: '✏️', pencil: '✏️', pen: '🖊️',
  phone: '📱', computer: '💻', laptop: '💻', camera: '📷', video: '🎥',
  gift: '🎁', balloon: '🎈', trophy: '🏆', medal: '🥇', ribbon: '🎀',
  time: '⏰', clock: '🕐', calendar: '📅', date: '📅', schedule: '📅',
  lock: '🔒', key: '🔑', unlock: '🔓', safe: '🔐', secret: '🤫',
  sword: '⚔️', shield: '🛡️', magic: '🪄', wand: '🪄', crystal: '🔮',
  muscle: '💪', strong: '💪', power: '⚡', energy: '⚡', lightning: '⚡',
  target: '🎯', dart: '🎯', goal: '⚽', soccer: '⚽', basketball: '🏀',
  100: '💯', hundred: '💯', perfect: '💯', poop: '💩', shit: '💩',
  skull: '💀', dead: '💀', ghost: '👻', alien: '👽', robot: '🤖',
  rainbow: '🌈', unicorn: '🦄', dragon: '🐉', mermaid: '🧜', wizard: '🧙',
  sleep: '😴', tired: '😩', yawn: '🥱', zzz: '💤', dream: '💭',
  sick: '🤒', mask: '😷', fever: '🤒', pill: '💊', doctor: '👨‍⚕️',
  pray: '🙏', bless: '🙏', hope: '🙏', wish: '🌠', luck: '🍀',
  clover: '🍀', leaf: '🍃', tree: '🌳', flower: '🌸', rose: '🌹',
  ocean: '🌊', wave2: '🌊', beach: '🏖️', island: '🏝️', mountain: '⛰️',
  world: '🌍', earth: '🌍', globe: '🌐', map: '🗺️', location: '📍',
  plus: '➕', minus: '➖', divide: '➗', multiply: '✖️', equal: '🟰',
  warning: '⚠️', danger: '🚨', stop: '🛑', forbidden: '🚫', info: 'ℹ️',
};

/** Returns matching emoji entries for a :query string (at least 2 chars after colon). */
export function getEmojiSuggestions(text: string): { key: string; emoji: string }[] {
  const m = /:([a-z0-9_]{2,})$/.exec(text.toLowerCase());
  if (!m) return [];
  const q = m[1];
  const results: { key: string; emoji: string }[] = [];
  for (const [k, v] of Object.entries(EMOJI_MAP)) {
    if (k.startsWith(q)) results.push({ key: k, emoji: v });
    if (results.length >= 16) break;
  }
  return results;
}

// ─── Big emoji detection ──────────────────────────────────────────────────────
const EMOJI_ONLY_RE = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}){1,3}$/u;

export function isBigEmoji(text: string): boolean {
  return EMOJI_ONLY_RE.test(text.trim());
}
