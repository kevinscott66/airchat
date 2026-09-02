# AirChat Design System

Version: 5.0 - written from scratch, 2026-09-02.
Supersedes: the 4.x document (kept at `scratchpad/design.v4.md` during review).
Platform: iOS first, Android second, web port (Expo web / react-native-web).
Surface: 17 screens under `src/ui/screens`, shared tokens in `src/ui/theme.ts`.

---

## 0. Provenance

This document is research-grounded, not written from memory. Sources, named
so that any claim below can be traced or contested:

- **Refero MCP styles/screens/flows: unavailable.** All three
  `refero_search_styles` calls returned `NO_SUBSCRIPTION`. Per the skill's own
  fallback rule, visual research was done against the bundled craft references
  and the local `ui-ux-pro-max` database, and the reference-lock workflow was
  kept unchanged. This is stated rather than hidden: a design that claims
  references it did not read is the same defect as an interface that claims a
  transport it does not have.
- `ui-ux-pro-max/data/products.csv` - product-type match for
  "Chat & Messaging App".
- `ui-ux-pro-max/data/colors.csv` - domain palette for "VPN & Privacy Tool".
- `ui-ux-pro-max/data/styles.csv` - Swiss Modernism 2.0, Dark Mode (OLED),
  Minimalism & Swiss Style, Modern Dark (Cinema Mobile).
- `ui-ux-pro-max/data/app-interface.csv` - 30 React Native platform rules,
  used as the accessibility and touch floor in sections 9-13.
- `ui-ux-pro-max/data/typography.csv`, `motion.csv`.
- `refero-design/references/anti-ai-slop.md`, `color.md`.
- The codebase itself: `src/ui/theme.ts`, `src/ui/platformCapabilities.ts`,
  and the four ratchet suites (`paletteLiterals`, `themeUsage`,
  `themeContrast`, `geometryScale`). Every contrast ratio quoted below was
  computed from the hex values, not estimated.

---

## 1. Brief

Designing a decentralised, end-to-end-encrypted messenger for people who have
a specific reason not to trust the network they are on, on iOS, Android and in
the browser.

- **Goal:** send a message and know what happened to it.
- **Tone:** instrument. Calm, dense, legible, unshowy, factual under pressure.
- **Main objection:** "decentralised" usually means "nothing arrives and no one
  tells me why."
- **Hook:** the interface reports the route a message actually took, and shows
  nothing it cannot substantiate.
- **Constraints:** existing WCAG-locked palettes defended by `themeContrast`;
  scale tokens asserted against this file by `geometryScale`; Russian-language
  UI; no Reanimated in the dependency tree (motion is RN `Animated` only);
  browser build cannot open sockets, browse mDNS, or run the embedded VPN.

---

## 2. Directions considered

Three reference-locked directions were built out. One was chosen. The other two
are recorded so the choice can be reversed on evidence rather than re-argued
from scratch.

**A. Instrument, not showcase - CHOSEN.**
Foundation: Swiss Modernism 2.0 (8px base unit, single vibrant accent, hierarchy
from weight and space rather than colour, WCAG AAA profile). Narrow borrowings:
the near-black canvas ladder from Dark Mode (OLED), applied to canvas only; the
micro-interaction discipline that `products.csv` attaches to chat apps, applied
only to message state.

**B. Modern Dark (Cinema Mobile) - rejected.**
Scores React Native 10/10 and Expo 10/10 in `styles.csv`, which is the strongest
platform fit available. Rejected on two counts. Its accent `#5E6AD2` is squarely
the indigo default that `anti-ai-slop.md` identifies as the single clearest
AI fingerprint. And its own row rates it WCAG **AA, "requires careful accent
contrast check"**, against a codebase whose palette is currently held above
4.5:1 on every surface by an executable test. Adopting it is a measurable
accessibility regression in exchange for atmosphere.

**C. E-Ink / Paper - rejected.**
The calmest and most distinctive of the three, and a genuinely good fit for
long-form reading. Rejected because `styles.csv` rates its dark-mode support
**Low**, and this product's default and most-used theme is dark. A style whose
weakness is exactly the mode most users live in is the wrong foundation, however
attractive its light theme is.

---

## 3. Reference lock

```
Primary direction: Swiss Modernism 2.0 - Instrument, not showcase

Preserve:
  - 8pt base unit; every spacing and geometry value is a multiple or a named
    exception with a written reason.
  - One accent. Colour is rare and always means something.
  - Hierarchy from type weight, spacing and alignment - not from colour,
    not from shadow, not from a card.
  - AAA-leaning contrast as a hard floor, enforced by test, not by taste.
  - Inter/system sans at a single family with weight variation. No display face.

Borrow only:
  - Dark Mode (OLED): the deep neutral canvas ladder, for canvas only.
  - Chat & Messaging micro-interactions: motion, but spent exclusively on
    message state transition.

Role rules (a token's role is part of the token):
  - accent = TEXT and iconography on a surface. Never a fill.
  - primary = FILL with light ink on top. Never body text.
  - success/successFill = connection and verification state ONLY. Never brand.
  - error/errorFill = failure and destruction ONLY. Never emphasis.
  - star = favourite/pinned ONLY.
  - Glass = one chrome surface per viewport. Never content, never loading.

Media strategy: none. This product has no hero imagery and will not grow one.
  Avatars are user data; identity colour is derived, not decorative. Where a
  reference would place an illustration, this system places an empty state with
  a sentence and an action.

Reject:
  - Indigo/violet as brand colour, including the current primary #3d5afe.
  - Cards as the default container.
  - Blur as a hierarchy carrier.
  - Decorative motion, looping ornament, gradient washes.
  - Any capability shown as "0" that the platform never had.

Token commitments: section 5 (colour), 6 (type), 7 (geometry), 8 (depth),
  9 (motion). All contrast figures measured.
```

---

## 4. Decision ledger

| Decision | Source | Source rule / role | Why |
|---|---|---|---|
| Swiss Modernism 2.0 as foundation | `styles.csv` | 8px base, single accent, AAA | Only researched direction whose native traits cooperate with an existing test-enforced contrast system instead of fighting it |
| Dark as the default theme | `colors.csv` "VPN & Privacy Tool" - "shield dark + connected green" | domain palette, not a style default | `anti-ai-slop.md` calls dark-by-default an AI tell; it is exempt here only because the product domain research names it. Light theme is fully specified and equally maintained, not an afterthought |
| Brand moves off `#3d5afe` to teal-cyan | `anti-ai-slop.md` tell #1 | accent discipline | `#3d5afe` is Material indigo-blue: the exact default the guide names. The fix is scoped to the token that is actually indigo - `primary` - not to a repaint |
| `accent` stays in the cyan family | existing `theme.ts` (`#7ecbff`, `#036B96`) | accent = text role | The accent token was never the indigo problem. Moving it too would be reference averaging: change what is wrong, keep what is right |
| Green reserved for connection state | `colors.csv` accent `#22C55E`, "connected green" | semantic, not brand | Promoting the connected-green to brand accent would destroy the one colour in the product that carries load-bearing meaning |
| Glass demoted from contract to one surface, then re-promoted in 4.32.532 once the a11y requirement was actually implemented (`src/ui/motionPrefs.ts`) | `app-interface.csv` "Respect Reduced Motion"/theming rows; code audit | material must survive a11y settings | The 4.x Liquid Glass Contract required readability under Reduce Transparency and nothing in `src` consulted `AccessibilityInfo`. The demotion was the honest answer while that was true; section 9 records the re-promotion and what paid for it |
| Motion budget: message state only | `products.csv` chat-app micro-interactions; `motion.csv` | micro-interaction, 150-300ms | No Reanimated in dependencies. A motion system that cannot be built is decoration in a document |
| Route strip as the signature detail | `platformCapabilities.ts` docblock | product truth | The one thing this messenger does that others do not is tell you which path a message took. That is the memorable detail, and it is factual rather than ornamental |
| Scale tokens unchanged | `geometryScale.test.ts` | executable assertion | The numbers were repaired in 4.32.528 and are now asserted against this file. Changing them from scratch would break 5472 passing tests to buy nothing |
| No imagery slot | `anti-ai-slop.md` tell #9 | preserve media role, or have none | Honest absence beats a faked illustration. This product genuinely has no media role to preserve |

---

## 5. Principles

**1. The message is the interface.** Everything else is chrome and yields to it.
If a surface, material or animation competes with a message for attention, the
surface is wrong.

**2. Say what happened.** Sent, queued, delivered, read, failed, and by which
route. Silence is the worst state a decentralised messenger can be in, and the
one it falls into most easily.

**3. Never show what you cannot substantiate.** A capability the platform lacks
is removed, not greyed out or zeroed. A number the app did not measure is not
printed. This rule already has an implementation (`platformCapabilities.ts`) and
a scar (section 14).

---

## 6. Colour

Two palettes, both measured. `themeContrast.test.ts` recomputes these ratios
from the same hex values, so a colour cannot be changed into illegibility
without a failing test.

Thresholds: text roles and semantics 4.5:1 on all three surfaces; `textMuted`
3:1 (it is a caption, never the sole carrier); light ink on `primary` 4.5:1;
fills that must be told apart from the surface under them 3:1.

### 6.1 Dark (default) - 4.32.533

Measured columns are `background` / `surface` / `surfaceHigh` unless the row says
otherwise. Recomputed from the hex values below; see section 19 for why the
palette moved off phosphor green.

| Token | Value | Role | Measured |
|---|---|---|---|
| `background` | **`#0B0B12`** | canvas - near-black with a violet undertone | - |
| `surface` | **`#14141F`** | sheets, rows | - |
| `surfaceHigh` | **`#1F1F2E`** | raised row, incoming bubble | - |
| `text` | **`#ECECF5`** | body | 16.70 / 15.56 / 13.82 |
| `textSecondary` | **`#A6A6BD`** | supporting | 8.23 / 7.66 / 6.81 |
| `textMuted` | **`#7C7C96`** | caption only (3:1 floor) | 4.84 / 4.51 / 4.00 |
| `accent` | **`#9B8CFF`** | periwinkle: link, read tick, active tab, hashtag | **7.09 / 6.60 / 5.87** |
| `primary` | **`#6A56EE`** | filled control | white **5.03**; as graphic 3.90 / 3.63 / 3.23 |
| `primaryMuted` | **`#221E42`** | selection wash | `text` 13.42; `textSecondary` 6.61; `accent` 5.70 |
| `ripple` | **`#6A56EE33`** | Android press wave | the one intentionally transparent token |
| `bubbleOut` | **`#242044`** | outgoing bubble fill | `bubbleOutText` 13.10; `accent` on it 5.56 |
| `bubbleOutText` | **`#ECECF5`** | all outgoing bubble content | - |
| `border` | **`#2E2E42`** | hairline - load-bearing, not decorative | vs `surface` 1.38; vs `surfaceHigh` 1.23 |
| `success` | **`#5BE39A`** | connected, verified - glyph/text | 12.05 / 11.22 / 9.97 |
| `successFill` | **`#1F7A55`** | connected - solid dot/badge | white 5.29; vs `surfaceHigh` 3.07 |
| `error` | **`#FF8A9B`** | failure - text | 8.74 / 8.14 / 7.24 |
| `errorFill` | **`#C8384C`** | failure - solid | white 5.09; vs `surfaceHigh` 3.19 |
| `warning` | `#F5B544` | amber - the only second signal | 10.81 / 10.07 / 8.95 |
| `star` | `#FFC44D` | favourite/pinned only | 12.38 / 11.53 / 10.25 |
| `mutedFill` | **`#6B6B85`** | muted-chat unread badge | white 5.16; vs `surfaceHigh` 3.14 |

Unlike 4.32.531, `primary` here clears the 3:1 fill floor on all three surfaces
(3.23 on `surfaceHigh`, the tightest). That was not cosmetic: the poll row draws
"your vote" as a bare `primary` swatch on `surface`, and at the first candidate
value (`#5B45E0`) it measured 2.93 and the contrast suite failed. The token was
lightened to `#6A56EE` rather than the test relaxed - white on it is still 5.03,
and `accent` vs `primary` is 1.82, far below the 4.5 that would make the two
read as different roles rather than one family.

### 6.2 Light - 4.32.533

| Token | Value | Role | Measured |
|---|---|---|---|
| `background` | **`#F4F4F8`** | canvas - cool paper | - |
| `surface` | `#FFFFFF` | cards, bubbles | - |
| `surfaceHigh` | **`#E7E7F0`** | raised | - |
| `text` | **`#141420`** | body | 16.64 / 18.25 / 14.85 |
| `textSecondary` | **`#575773`** | supporting | 6.35 / 6.96 / 5.67 |
| `textMuted` | **`#74748E`** | caption only | 4.13 / 4.53 / 3.69 |
| `accent` | **`#5340C9`** | link, read tick, active tab | **6.50 / 7.13 / 5.80** |
| `primary` | **`#5340C9`** | filled control | white **7.13** |
| `primaryMuted` | **`#E5E1FA`** | selection wash | `text` 14.32; `accent` on it 5.60 |
| `ripple` | **`#5340C933`** | press wave | - |
| `bubbleOut` | **`#5340C9`** | outgoing bubble | `#FFFFFF` on it 7.13 |
| `bubbleOutText` | `#FFFFFF` | - | - |
| `border` | **`#D1D1E0`** | hairline | vs `surface` 1.51 |
| `success` / `successFill` | **`#1B6E4C`** | connection state | white 6.21 |
| `error` / `errorFill` | `#C0261B` | failure | white 5.94 |
| `warning` | `#8A5300` | degraded | 5.77 / 6.33 / 5.15 |
| `star` | `#8A6A00` | favourite only | 4.62 / 5.07 / 4.12 |
| `mutedFill` | **`#575773`** | muted unread badge | white 6.96 |

Light `success` moved from `#1F6B45` to `#1B6E4C` for a mechanical reason: the
new `surfaceHigh` (`#E7E7F0`) is lighter than the 531 one, which dropped the
inherited green to 4.30 against it. Darkening the green was the cheaper fix -
lifting `surfaceHigh` back down would have flattened the light theme's whole
elevation ladder to repair one badge.

In light, one value serves both the text role and the fill role for `accent`/
`primary` and for each semantic pair. In dark it cannot: `error` there is a pale
rose that white cannot sit on. The tokens stay separate in both palettes so that
the role distinction survives the theme where it is not strictly needed.

### 6.3 Rules

- Colour never carries meaning alone. Every state that has a colour also has a
  word or a glyph. Cyan accent and the connected green are close enough in hue
  that a deuteranopic user should not have to distinguish them, and under this
  rule they never have to.
- No screen-local colour literals. `paletteLiterals.test.ts` holds the line.
- The user-chosen accent from Settings expands into both roles by different
  paths: `normalizeAccent()` prepares the fill, `readableOn()` derives the text
  colour. A swatch that fails 4.5:1 does not ship; `ACCENT_SWATCHES` carries its
  measured ratio next to every entry for exactly that reason.
- Identity colours (avatar hues) are derived from the identity, not chosen.
  They are data, not palette.

---

## 7. Typography

One family, system sans (Inter where available). Hierarchy comes from weight and
space. `typography.csv` puts Inter at the head of every relevant pairing for this
product class, and every one of those pairings is single-family with weight
variation - which is also the only kind of hierarchy that survives Dynamic Type.

| Role | Token | Weight |
|---|---|---|
| Screen title | `font.xxl` 24 | `semibold` 600 |
| Section title | `font.lg` 17 | `semibold` 600 |
| Body, message text | `font.md` 15 | `regular` 400 |
| Label, control | `font.sm` 13 | `medium` 500 |
| Caption, timestamp, route | `font.xs` 12 | `regular` 400 |

- **Nothing is smaller than 12.** The single exception is `badgeDigit` (10): the
  counter digit inside a filled circle. It is a named token so that the exception
  is reviewable - an exception with a name can be argued about, an exception with
  only a value cannot.
- No negative letter spacing. No viewport-scaled sizes. ALL CAPS, if it appears
  at all, carries positive tracking.
- `allowFontScaling` stays on. It is currently disabled at three sites in
  `SplashOverlay`, where the layout is fixed and pre-locale; nowhere else may
  copy that.
- Prefer wrapping to truncation. Where truncation is unavoidable, the full text
  must be reachable by tap or long-press.
- Tabular figures for timers, counters and sizes so that numbers do not reflow
  as they tick.

---

## 8. Geometry and spacing

8pt base unit. These scales live in `src/ui/theme.ts` and are the only source of
geometry. `src/ui/__tests__/geometryScale.test.ts` asserts that the numbers below
and the numbers in the code stay equal, and ratchets down the count of sizes
still written as bare numbers.

| Scale | Values |
| --- | --- |
| `font` | `xs` 12, `sm` 13, `md` 15, `lg` 17, `xl` 20, `xxl` 24 |
| `weight` | `regular` 400, `medium` 500, `semibold` 600, `bold` 700 |
| `radius` | `sm` 10, `md` 16, `lg` 22, `xl` 30, `full` 9999 |
| `spacing` | `xs` 4, `sm` 8, `md` 12, `lg` 16, `xl` 24, `xxl` 32 |
| `elevation` | `raised`, `card`, `overlay` |
| `motion` | `fast` 140, `base` 220, `slow` 340, `spring`, `pressScale` 0.96 |
| `glass` | `intensity` 26/52/78, `fill` 0.30/0.52/0.74, `rim` 0.16, `shade` 0.08 |
| `TOUCH_TARGET_MIN` | 44 |

The ratchet exists because of what 4.32.528 found: the tokens had drifted from
the written rule (`spacing` ran 4/8/14/20/28 against an 8/12/16/24 rhythm,
`radius.sm` was 6 against a floor of 8, `font.xs` was 11 against a floor of 12).
Anyone who reached for a token got something other than the documented value, so
the next person wrote the number by hand instead. Eight files out of 102 used the
tokens at all; 20 distinct radii and 20 distinct font sizes had accumulated. A
rule that contradicts its own implementation is not a rule.

The radius scale has now been argued three ways, and the record is kept in full
because the reversals are the useful part.

- Through 4.32.530 it was 8/12/16/18, on the argument that a square bubble reads
  as a code block.
- 4.32.531 cut it to 2/4/6/8, on the argument that a near-square corner reads as
  *instrument* - a panel, a switch, a readout.
- **4.32.532 raises it to 10/16/22/30.** The instrument argument is not wrong,
  it is incompatible with the material this version commits to. Liquid glass is
  defined by its edge: a bright rim along the top of the panel, a shaded one
  along the bottom. A rim needs a continuous curve to travel along. At radius 4
  it hits a corner, breaks, and the surface stops reading as a solid object with
  thickness and starts reading as a blurred rectangle. Either the glass goes or
  the corners come back; the direction says the glass stays.

`radius.full` survives for the three things that are genuinely round - keypad
key, pulse ring, colour swatch - and for nothing else.

**Bubbles.** `radius.lg` = 22 on all four corners, and the author-side corner is
`radius.sm` = 10 rather than a bare 4. The anchor corner still exists, because it
is the one cue that says which side sent the message without a colour, but at a
22pt bubble a 4pt corner is not a tail, it is a chip out of the shape.

The Swiss traits kept are unchanged: the base unit, the single accent, and
hierarchy without shadow.

- Controls are at least 44pt tall and 44pt wide. Where the glyph is smaller, the
  hit area is extended with `hitSlop`, not by growing the glyph.
- At least 8pt between adjacent touch targets.
- One primary action per screen. Secondary actions are visually subordinate.

---

## 9. Depth and material

Three elevation levels: `raised`, `card`, `overlay`. Shadow values are never
written inline - three levels are enough to express hierarchy, and a fourth one
written by hand is not a level, it is an inconsistency.

**Glass is promoted, and the promotion is paid for.** Through 4.32.531 blur was
demoted to a single surface, on the entirely fair grounds that the document
demanded Reduce Transparency support that no line of `src` provided. A rule that
is written and never implemented is not true.

4.32.532 keeps the objection and removes its cause. `src/ui/motionPrefs.ts` now
subscribes to `AccessibilityInfo` once per process and exposes both flags;
`GlassSurface` reads Reduce Transparency and, when it is on, drops the `BlurView`
entirely and paints the fill at full opacity. The requirement is now enforced in
code, in one place, which is why there is exactly one implementation point.

Glass is three layers, not one: blurred backdrop, translucent fill over it, and a
light rim along the top edge with a dark shade along the bottom. The rim is what
separates glass from a smudged patch of background - it is the only thing that
communicates thickness. `glass.rim` / `glass.shade` in the theme own those two
hairlines.

The standing rules:

- `GlassSurface` is permitted on **navigation and overlay chrome**: the tab bar,
  the chat-list header, sheets and modals. Never on a row, a bubble, or a card.
  Two glass layers may be visible at once (header and tab bar); a third is a bug.
- It is chrome. It never contains message content, never indicates loading,
  never carries state.
- Its opaque fallback must be legible on its own, because under Reduce
  Transparency, and on platforms where blur degrades, it is the whole thing.
- Glass needs something to blur. A glass panel in normal flow blurs the page
  background and nothing else, which is a tinted panel wearing a costume. The
  chat-list header is therefore a real overlay: it is absolutely positioned, it
  measures its own height with `onLayout`, and the list below is padded by that
  height so rows travel under it. **The tab bar is not** - it sits in flow, and
  the comment in `src/App.tsx` says so rather than claiming otherwise. Making it
  a true overlay means adding a bottom inset to every scroll container on every
  screen, and that is a separate piece of work, not a side effect of this one.

---

## 10. Motion

Motion is RN `Animated` (Reanimated is present but used only by `MediaViewer`).
Durations and the spring come from the `motion` block in `src/ui/theme.ts` -
`fast` 140, `base` 220, `slow` 340 - so "modern and animated" cannot mean "every
screen invents its own timing".

- **150-300ms** for micro-interactions; nothing in core UI over 400ms.
- Ease-out entering, ease-in exiting; exit runs at roughly 60-70% of enter.
- `transform` and `opacity` only. Never width, height, top or left.
- One or two animated elements per view. Animation is interruptible: a tap
  cancels it and the UI stays live throughout.
- Forward navigation moves left/up, back moves right/down, consistently.
- Press feedback appears within 100ms. On Android that is `ripple`; everywhere,
  `AppPressable` scales the pressed element to `motion.pressScale` (0.96) over
  `motion.fast` and springs it back. It lives in `AppPressable` because that
  wrapper is already in 76 files and is the only sanctioned place to change how
  every button in the app behaves. `noScale` opts an element out.

**The content motion budget goes to message state and to arrival.** Queued to
sent to delivered to read is the one transition a user of this product actually
watches. Arrival is the second: a new bubble fades in and rises 10pt over
`motion.base`.

That entrance is gated on the message being **younger than two seconds at mount**,
and the decision is taken once, in a ref. `FlatList` recycles rows, so an
ungated entrance would replay the entire conversation every time it was scrolled
back and forth - which is precisely the case where animation stops being
delightful and starts being an obstacle. Screen decorations and empty states
remain static.

`app-interface.csv` marks "Respect Reduced Motion" **Critical**. As of 4.32.532
it is implemented: `useReducedMotion()` / `isReducedMotion()` in
`src/ui/motionPrefs.ts`, consulted by `AppPressable` (no press scale) and by the
bubble entrance (mounts at its final position). The press handler reads the flag
synchronously rather than through a hook, because a hook in `AppPressable` would
mean hundreds of listeners on one boolean.

---

## 11. Components

**Bubble.** The core object. Incoming is `surfaceHigh`; outgoing is `bubbleOut`
with `bubbleOutText`. Ink inside a bubble derives from the bubble's own fill via
`bubbleSurface()` / `useBubbleSurface()`, never from the page palette - a bubble
is a surface, and text on it must be measured against it.

**Route strip.** The signature detail. Every outgoing message carries, at
`font.xs` in the bubble's secondary ink, the transport it actually travelled:
WebRTC, libp2p, IPFS, LAN, relay. It is written, not coloured. It appears only
when the route is known; an unknown route prints nothing rather than guessing.
This is the one thing on screen that no other messenger shows, and it is the
product's argument in a single line of 12pt text.

**List row.** Full-bleed, hairline-separated, no card. Minimum 44pt. The row is
the container; a card inside a list is a card because the designer could not
think of another way to group things.

**Cards.** Default is no card. A card is justified only when it is the container
for an interaction - a tappable item, a form, an expandable panel. If removing
its border, shadow, background and radius costs nothing in understanding or
interaction, it was not a card. Never nest a card in a card; the only exception
is a real attachment or bubble inside a message.

**Badges.** Filled circle, `badgeDigit` inside, ink from `contrastingInk()`.
`mutedFill` when the chat is muted, `errorFill`/`primary` otherwise.

**Empty states.** A sentence saying what would be here and one action. No
illustration. This system has no media role, and inventing one to fill space is
the failure mode `anti-ai-slop.md` calls faking imagery.

**Icons.** `@expo/vector-icons`, one set, consistent stroke weight. Icons carry
the action; labels explain only ambiguous ones. Never emoji as an icon. Every
icon-only control gets an `accessibilityLabel`; decorative icons are marked not
accessible so a screen reader does not read the furniture.

---

## 12. Navigation

Five bottom destinations, maximum. Icon plus label - icon-only navigation costs
discoverability, and this product's audience is not always technical. The active
destination is marked by accent colour *and* icon shape, never by colour alone.

The tab bar is the single glass surface (section 9), floating above content and
the safe area.

Top bars are compact and scroll-aware: transparent until the content beneath
needs a stable contrast surface. Identity data is not repeated in every header.

- Back is predictable and preserves scroll position, filters and input.
- Every modal and sheet has a visible close affordance in addition to
  swipe-to-dismiss. Gesture-only escape is not an escape.
- The navigation stack is never silently reset.
- Deferred tab mounting and latest-tap-wins behaviour are preserved; they are a
  performance property, and `tabsReachable.test.ts` guards reachability.

---

## 13. States and feedback

- Anything over 300ms shows a skeleton or an indicator; buttons disable while
  their action is in flight.
- Success is confirmed visibly. Silent completion is indistinguishable from
  failure.
- Errors state cause and recovery, next to the field or object that failed, not
  only in a banner at the top. `errorTextCallSites.test.ts` guards the phrasing
  discipline.
- Destructive actions confirm first and use the failure colour, visually
  separated from the primary action. Where undo is possible, offer undo instead
  of a confirmation.
- Validate on blur and on submit, not on every keystroke.
- Toasts auto-dismiss in 3-5s, never steal focus, and announce politely.
- Empty, loading, error and offline are designed states, not omissions.

---

## 14. Platform capabilities

The web port cannot open a listening socket, browse mDNS, drive Wi-Fi Direct, or
run the embedded VPN. Capabilities the platform does not have are removed from
the interface, not shown empty: "Wi-Fi LAN - 0 devices" reads as "we looked and
found nothing" when the browser was never able to look. Showing a zero where
there was no count is lying with a zero.

The boundary is declared once, in `src/ui/platformCapabilities.ts`, and not
re-derived at each call site.

**The rule covers prose, not just controls.** Gating the Wi-Fi LAN *switch*
while leaving the sentence "peers on your local network are discovered
automatically" underneath it still tells the user something untrue - and a
sentence is worse than a stale toggle, because a toggle that does nothing gets
reported as a bug while a promise that never arrives gets blamed on the user.
Four such sentences were found on the web build in 4.32.528: the About block in
`ProfileScreen`, the "connection without internet" card in `HelpScreen`, the
Wi-Fi LAN section of `PrivacyPolicyScreen`, and the LAN card in
`DiagnosticScreen` (already gated). The privacy policy is the sharpest case: it
answers "what does this app do with my data", so a section describing a network
the app cannot touch here does not merely mislead - it blurs what the user is
consenting to.

When adding copy that names a transport, check it against `platformCapabilities`
the same way a control would be checked.

---

## 15. Implementation delta

This document is written from scratch; the codebase is not. What follows is the
exact distance between them, so that nothing here is mistaken for shipped.

**Already conforms - no work.**
Scale tokens and their ratchet. Contrast thresholds and `themeContrast`.
Palette-literal and theme-usage ratchets. Bubble ink derivation. Identity
colours. Platform-capability gating, controls and prose. The 12pt readability
floor and the named `badgeDigit` exception. Deferred tab mounting.

**Token changes - one commit, `theme.ts` only.**
Dark: `primary` `#3d5afe` to `#157A8A`; `primaryMuted` `#2a3555` to `#1B3A42`;
`ripple` to `#157A8A33`; `accent` `#7ecbff` to `#5CD8E8`; `bubbleOut` `#1a2e5e`
to `#103845`; `border` `#2a3555` to `#293E49`.
Light: `primary` `#0068D6` to `#00697F`; `accent` `#036B96` to `#00697F`;
`primaryMuted` `#E1F0FF` to `#DEF0F5`; `ripple` to `#00697F33`; `bubbleOut` to
`#00697F`.
Every replacement measures equal or better than the value it replaces; the
figures are in section 6 and `themeContrast` will recompute them. Note that
`ACCENT_SWATCHES[0]` is `#3d5afe` named "синий" - as a user-selectable swatch it
stays; it is only the *default brand* that moves off indigo.

**Form changes - shipped in 4.32.530.**
The token pass above moved the hue and nothing else, and a hue is not a design.
These are the shape changes that carry the direction, each one visible without
being told to look for it:

| Change | Where | Why it follows from section 2 |
|---|---|---|
| Circle avatar to rounded tile (`avatarShape`; radius was `0.3 x side` in 4.32.530, fixed `AVATAR_RADIUS` = `radius.md` since 4.32.531, = 16 since 4.32.532) | `theme.ts` and every identity surface: chat list, chat, groups and group info, feed, profile, contacts, settings devices, stories ring, call overlay, contact-card bubble, poll voters, and the forward / seen-by / member / join-request / reaction / stats modals | The circle is the badge of a feed. This list is a table; a tile holds the same column as the name and the time beside it. Applied to one screen it reads as a bug, so it is applied to every place an identity is drawn - round shapes now mean control (keypad key, send button, pulse ring, colour swatch), never person. |
| Floating glass header to flush page top with a hairline rule | chat list, feed | Glass was on four surfaces; section 9 allows one. The header is the top of the page, not an object above it. |
| Segmented pill filters to underline tabs | chat list | A capsule inside a capsule beside a capsule search field: state was a third fill among fills. Underline states by form. |
| Uniform bubble radius to a 4pt anchored corner on the sender's side | chat, groups | Author was carried by colour and screen edge alone. The cut corner survives high contrast, narrow columns, and a monochrome accent. |
| Bubble max width 88% to 80% | chat | A ragged right edge is what makes a column read as a column. |
| Pill composer and round buttons to 12pt soft rectangles | chat, groups | The pill was the same shape as the search field, the filters, the badges and the tab bar. Nothing distinguished an input from a label. |
| Floating capsule tab bar to a flush bar with a top rule | `App.tsx` | Same argument as the header, at the other edge. It also returns the horizontal margin to the content. |
| Tabular figures on every time, counter and badge | chat list, chat, tab bar | An instrument's numbers must not shift width between 9:05 and 12:44. |

Every literal touched in this pass was replaced by a token (`font`, `radius`,
`spacing`, `TOUCH_TARGET_MIN`, `avatarShape`), so the `geometryScale` baselines
fall rather than hold - which is the ratchet working as designed.

**New work still outstanding.**
1. ~~`AccessibilityInfo.isReduceMotionEnabled` and
   `isReduceTransparencyEnabled` are consulted nowhere.~~ **Closed in 4.32.532**
   by `src/ui/motionPrefs.ts`; see sections 9 and 10.
2. The route strip still does not exist, and it cannot be built from the UI
   alone: no message row records which transport carried it. Printing a guess
   would be exactly the defect section 0 names. It needs a column first.
3. `SkeletonLoader` still draws **circular** avatar placeholders while every real
   avatar is a tile, so the skeleton promises a shape the content does not keep.
4. The settings screen gives each icon tile its own hue (pink, orange, purple,
   blue, red), against the two-signal rule in section 5 and section 17.2.
5. ~~The composer's emoji button is a literal 😊 glyph, against the
   no-emoji-icons rule.~~ Fixed in 4.32.533 - see section 19.3.

---

## 16. Change workflow

1. Read this file before changing UI.
2. Implement through shared tokens and components first. Add a screen-local
   style only when no token fits, and say in a comment why none did.
3. If a scale or a colour in this document changes, change `src/ui/theme.ts` in
   the same commit. `geometryScale.test.ts` and `themeContrast.test.ts` fail when
   they disagree, which is the entire point of them.
4. New copy that names a transport is checked against `platformCapabilities`.
5. Verify iPhone 16 and iPhone 16 Plus layouts, both themes, large text, and the
   keyboard-open state before committing.
6. Run `npm run typecheck`, `npm run lint`, and the UI/theme suites
   (`paletteLiterals`, `themeUsage`, `themeContrast`, `geometryScale`) before an
   iOS build.

---

## 17. Visual language change - 4.32.531

Two consecutive redesign passes (4.32.529 tokens, 4.32.530 form) were rejected by
the user with the same sentence: nothing really changed. Both passes were real -
the hue moved, then eight structural moves shipped - and both were invisible,
because both stayed inside the same visual system: navy canvas, cyan-teal accent,
12-16pt corners, one type scale, one component vocabulary. Rearranging a system
is not replacing it.

### 17.1 Three directions, generated

Rather than argue a fourth time from tokens, three whole-screen directions were
generated as images (Higgsfield, `nano_banana_2`), each a full chat + list +
settings sheet, so the difference could be judged as a picture rather than as a
diff:

1. **Swiss instrument panel** - white/graphite, hairline grid, no fills.
2. **Brutalist editorial paper** - paper canvas, heavy type, black rules.
3. **Rugged field radio terminal** - graphite/olive canvas, phosphor-green
   signal, near-square geometry, monospace as a role.

**Direction 3 was chosen.** Honest record of how: this environment has no
external network egress, so the generated PNGs could not be fetched or rendered
here and the user has not seen them. The choice was made on the argument below
and is cheap to reverse, because it lives almost entirely in `theme.ts` tokens.

The argument: AirChat is an infrastructure-free P2P messenger. Its whole subject
is *whether there is a link* - not conversation, not feed, not identity. A comms
instrument is the one metaphor that is about the product rather than about chat
apps in general, and it is the furthest of the three from the navy-and-teal
system that was twice rejected. 1 keeps the same restraint that already failed to
register as change; 2 fights the dark default the product actually runs in.

### 17.2 What the direction commits to

| Move | From | To | Consequence |
|---|---|---|---|
| Canvas | navy `#0b1020` ladder | graphite `#0F1211` / olive `#171C18` / `#212A21` | The screen stops reading as "night mode of a blue app" and starts reading as a device face. Warmer than black, neutral enough not to be a brand colour. |
| Signal | teal `#7ecbff` | phosphor `#9BE86B` (`accent`, 11.6:1 on canvas) | In an app whose entire meaning is *having a link*, the colour of the link has to be the loudest thing on screen. Green is the only colour that already means "carrier present" without a legend. |
| Fill | `primary` teal | `primary` `#317632`, white ink 5.57:1 | The role split from section 5 is unchanged: `accent` is text, `primary` is fill. A light phosphor cannot be a fill and is not used as one. |
| Second signal | several | amber `#E8A33D` only | Two signals, no more: phosphor and amber. Everything else is neutral. |
| Geometry | radius 8-18 | radius 2-8 | See section 8. |
| Avatar | `0.3 x side` | fixed 4pt at every size | The ratio made an 88pt profile avatar a 26pt near-circle - the tile rule was invisible exactly where the avatar is largest. |
| Depth | `raised` / `card` shadows | shadow 0; borders carry separation | `overlay` survives, hard-edged (radius 0 blur). Panels are divided by an olive rule, which is load-bearing here rather than decorative. |
| Monospace | 4 different literals across 13 files | one `mono` token, plus `tracking.caps` | Monospace is a *role* in this direction (identifiers, keys, counters, addresses), so it needs a name. |

Light mode moves with it: warm paper `#EDEFE9` instead of blue-grey, the same
green at `#2F6A1E` (5.66:1 as text, 6.03:1 white-on-fill), and `success`
deliberately *not* equal to `accent` - when they were identical the status
badges collapsed from five distinguishable tones to four.

### 17.3 How it reaches the screens

The direction is applied through tokens, not screen by screen, so it lands on all
17 screens at once:

- every colour already routes through `theme.ts` (`paletteLiterals` enforces it);
- 270 hand-written radii across 67 files were moved onto `radius.*`, skipping the
  66 that are genuinely circles;
- 13 files were moved onto `mono`;
- `SplashOverlay.tsx` is marked `@stable`, and only its four colour constants
  were changed - no structural or animation change. Flagged for approval rather
  than done silently.

`geometryScale.test.ts` was updated in the same pass: the range assertion now
reads 2-8, and `RADIUS_BASELINE` was regenerated (30 entries / 70 literals, down
from ~200 entries), because the ratchet fails on *shrinkage* as well as growth.


---

## 18. Liquid Glass and motion - 4.32.532

Section 17 recorded a direction the user then reversed in one sentence: *"лучше
более современный анимированный и топовый дизайн с внедрением ликвид гласс, а
облачка с более укруглёнными углами"*. That is not "it still looks the same" for
a third time - it is a different destination. The field-terminal direction was
built out of hard edges, flattened shadows and borders-instead-of-depth; the ask
is round, glassy, animated and deep. The two cannot be reconciled, so 17 is kept
as the record of how the palette was chosen and 18 overrides its geometry and
material.

**What is kept from 17.** The whole colour system: graphite/olive canvas,
phosphor `#9BE86B` as `accent`, `#317632` as `primary`, amber as the only second
signal, the `accent`-is-text / `primary`-is-fill split, and the measured ratios
in section 6. The palette was never what the user objected to.

**What is reversed.**

| Move | 4.32.531 | 4.32.532 | Why |
|---|---|---|---|
| Radius | 2 / 4 / 6 / 8 | 10 / 16 / 22 / 30 | A glass rim needs a continuous curve to travel along. See section 8. |
| Bubble anchor | bare 4pt corner | `radius.sm` = 10 | At a 22pt bubble a 4pt corner is a chip, not a tail. This is the user's "облачка с более укруглёнными углами", literally. |
| Avatar | `AVATAR_RADIUS` = 4 | `AVATAR_RADIUS` = `radius.md` = 16 | Follows the scale. Still a tile, not a circle - the 17.2 rule that round means *control* holds. |
| Depth | `raised` / `card` shadows zeroed | restored, soft and wide (0.10/4, 0.18/16, 0.34/36) | Glass is flat by nature: it is a filter, not an object. The only thing that gives it height is the shadow underneath it. Removing the shadows and then asking for glass would give a blurred sticker. |
| Glass | one surface (tab bar) | navigation and overlay chrome, with the a11y requirement actually implemented | See section 9. |
| Tab bar | flush bar with a top rule | floating capsule, `radius.xl`, `elevation.overlay` | A capsule is an object; an edge-to-edge bar is a border. Glass has to be an object. |
| Chat-list header | flush page top with a hairline | floating glass capsule, **absolutely positioned**, list padded by its measured height | This is the one surface in the app where glass is doing its real job: rows travel underneath and blur. |
| Motion | press feedback only, no tokens | `motion` token block; global press scale; bubble arrival | See section 10. |

**New token blocks in `theme.ts`.** `motion` (`fast` 140, `base` 220, `slow` 340,
`spring`, `pressScale` 0.96) and `glass` (`intensity` 26/52/78, `fill`
0.30/0.52/0.74, `rim` 0.16, `shade` 0.08, `shadeInk`). Both are in section 8's
table, and both exist for the same reason the geometry scales do: so that "how
much glass" and "how fast" are answered in one file rather than per screen.

**`@stable` files touched, flagged rather than done silently.**
`AppPressable.tsx` gained the press-scale default and a `noScale` opt-out. The
marker's own text says the file is "единая точка настройки defaults для всех
кнопок приложения", which is exactly what was added - but it is still a change to
a file marked stable, and it changes how all 76 files' buttons behave.

**Honest limits of this pass.**
- The tab bar is glass but sits in normal flow, so it blurs the page background
  rather than the content. Making it a true overlay needs a bottom inset in every
  scroll container on every screen. Section 9 says so; the comment in `App.tsx`
  says so. It is not claimed as done.
- Only the chat-list header was converted to a real overlay. Feed, groups and
  the remaining headers still sit in flow.
- Sheets and modals are permitted glass by section 9 but have not been converted
  yet.

---

## 19. Palette, wallpaper and motion - 4.32.533

Fourth redirection, verbatim: "оттенок такой себе, так же нужен задний фон (и
возможность его сменить в чате/группе) и крутые анимации и переходы", then, on
the choice of accent: "по твоей рекомендации, более современный, молодёжный и
плавный дизайн / и в идеале реализовать эффект стекла". A fifth followed mid-pass:
"на андроидах/компах в чате лучше подогнать иконку эмодзи под остальные, а на
айфоне можно и вовсе убрать или тоже подогнать по дизайну".

### 19.1 The phosphor palette is withdrawn

Section 17 argued for olive canvas and phosphor green as "field terminal". The
argument was internally consistent and the user rejected it twice. It is
withdrawn, not defended.

What replaces it: a neutral graphite canvas with a violet undertone
(`#0B0B12`), one violet used as a fill (`#6A56EE`) and one periwinkle used as
text (`#9B8CFF`). Full tables in sections 6.1 and 6.2.

The technical reason for this specific pair rather than another hue: under
frosted glass a colour survives mostly as lightness, because the blur destroys
edges before it destroys luminance. The 531 pair `#317632`/`#9BE86B` had a
narrow lightness spread; `#6A56EE`/`#9B8CFF` roughly doubles it, so the
active-tab accent still separates from the filled control after both pass
under a `prominent` surface.

**The anti-slop caveat, stated plainly.** Indigo/violet is named in every
anti-AI-slop guide as *the* generated-UI default, and the `refero-design`
reference this project uses says so outright: "Do not default to indigo/violet
unless the user explicitly asks for it." The user did not name a hue - they
delegated the choice. The defence is therefore not "this hue is not a default"
but a constraint on how it is used:

- exactly two roles, fill and text accent, with no third violet anywhere;
- the canvas is *not* tinted toward it (the undertone is 7 points of blue over
  neutral, not a violet field);
- product identity is carried by the wallpapers, which are per-conversation and
  differ from each other, not by the accent, which is constant.

If the user rejects this pass too, the honest next move is a hue the guides do
not flag, not a fifth defence of the same one.

### 19.2 Background is a layer, not a colour

Per-conversation wallpapers already existed (4.32.410/487) and were invisible:
eleven near-identical flat squares, and nothing at all by default. The feature
was not missing, it was inert. What changed:

- `WALLPAPER_MESHES` - six named gradient meshes (Аврора, Рассвет, Сумерки,
  Прилив, Уголь, Иней), each a base fill plus two or three soft radial blobs.
- `WallpaperBackground` draws them with `react-native-svg`
  (`RadialGradient` + `Ellipse`). Not `expo-linear-gradient`: it is not
  installed and cannot be installed here - external network egress is blocked.
  Not bundled images: six PNGs at phone resolution cost more than the numbers.
- A default. `defaultWallpaper(scheme)` gives Аврора in dark and Рассвет in
  light, so a conversation with no explicit choice still has a background. The
  storage contract is untouched: screens resolve `stored ?? default` and never
  write the default, so `feedGround(p, null).ground === p.background` still
  holds and the existing tests still mean what they meant.
- Stored value is the preset **id**, not the colours. Writing five numbers into
  storage would freeze the gradient at the version that wrote it. An unknown id
  falls back to the theme background, which is what makes changing the set safe.
- Drift: 28 s, ±14 px translate, 1.06→1.12 scale, gated on `isReducedMotion()`.
  Deliberately slower than it wants to be - this layer lies *under* the
  conversation, and anything noticeable on it competes with the text.

**The contrast problem a gradient creates, and the answer.** Every plate in the
feed derives its ink from the colour beneath it, and a gradient has no single
colour beneath it. So each mesh declares a `ground`: the blob composite that
moves the surface *furthest toward* the ink - the maximum-luminance stack for a
dark mesh, the minimum for a light one, taken over all subsets and orders of the
blobs because they overlap (most have `rx` near 0.9, nearly the full width).
A plate proven against that point is legible over the entire field.
`themeContrast.test.ts` recomputes the composites from the blob table and
requires the declared `ground` to equal it, then runs the full plate-legibility
battery against it in both themes. The numbers in `wallpapers.ts` are computed,
not eyeballed.

### 19.3 The emoji button

The composer's toggle was a literal `😊` in a `<Text>`. Rendered by the system
emoji font - Noto Color Emoji on Android, whatever is installed on web - it sat
next to monochrome Ionicons looking like it had been pasted in from somewhere
else, which is what the user described. It is now
`<Ionicons name={open ? 'keypad-outline' : 'happy-outline'} />` in both
`ChatScreen` and `GroupsScreen`. One glyph from the app's own set answers all
three platforms in the user's message at once: identical on Android, desktop web
and iPhone, so there is nothing left to remove on iPhone specifically.

### 19.4 Motion

Three additions, all gated on `isReducedMotion()`, all driving off the `motion`
tokens:

- `TabGlyph` - the active tab's highlight is a pill *behind* the glyph that
  grows from 0.7 and fades in over `motion.base`. Behind, not on the glyph
  itself, so the icon does not move when selected. Before this, selecting a tab
  was two instant swaps in one frame (filled icon, accent label) and read as a
  repaint rather than a transition.
- `ScreenSlot` - tab bodies stay mounted and hidden via `display` (unchanged:
  remounting five trees costs ~2.2 s of JS). The *incoming* screen now fades
  from 0.35 and rises 12 px. Only the incoming one: `display: 'none'` lands in
  the same frame, so an exit animation cannot exist here, and starting the
  entrance from full transparency would flash the app background between tabs.
- `SheetShell` - bottom sheets. The scrim fades while the sheet springs up, and
  the modal window is held mounted past `visible: false` so the exit actually
  plays. `animationType="slide"` could not do this: it moves the whole window,
  scrim included, and skips the exit entirely.

### 19.5 Glass

`SheetShell` renders its sheet as `GlassSurface variant="prominent"`. This is
the one case section 9 describes exactly - a layer with arbitrary content
underneath - and unlike the tab bar it is a true overlay already, so no scroll
inset is needed anywhere. Migrated so far: the chat/group wallpaper picker.

**Honest limits of this pass.**
- Only one sheet is on `SheetShell`. The other bottom sheets, and the ~36
  centred dialogs, still open with `animationType="slide"` / `"fade"`.
- The tab bar is still in normal flow, so its glass still blurs the page
  background rather than the conversation. Unchanged from 4.32.532, and still
  not claimed as done.
- The wallpaper picker shows gradient swatches as live miniatures, which means
  six animated SVG layers exist while that sheet is open. Acceptable because it
  is a sheet the user opens deliberately and closes; it would not be acceptable
  in a list.
