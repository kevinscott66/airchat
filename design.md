# AirChat Design System

Status: active
Platform: iOS first, Android fallback, web-compatible where possible
Reference: Refero Styles (`https://styles.refero.design/`)
Material direction: Liquid Glass, used selectively

## Product Character

AirChat is a private messenger with a calm, technical, human interface. The
content is the hero: messages, people, and actions should remain legible before
the material is noticed.

Visual keywords: quiet confidence, graphite, daylight blue, precise spacing,
soft depth, native motion.

## Visual Rules

- Use the existing theme tokens from `src/ui/theme.ts`; do not add screen-local
  color literals.
- Keep the dark foundation neutral graphite/navy. Cyan-blue is an accent, not a
  full-screen wash.
- Use Liquid Glass only for the tab bar, top-level toolbars, sheets, and one
  primary action cluster per screen.
- Use `GlassSurface` for blur-backed surfaces. Keep list rows and message
  bubbles opaque enough to preserve scanning and contrast.
- Prefer one strong surface over several nested cards. Do not put a card inside
  another card unless the inner object is a real attachment or message bubble.
- Use 8, 12, 16, and 24 as the spacing rhythm. Standard controls are at least
  44 points tall.
- Use 8-18 point corner radii depending on hierarchy. Avoid pill-shaped text
  containers except for compact status or input controls.
- Icons come from `@expo/vector-icons` and carry the action; labels explain
  only ambiguous actions.

## Liquid Glass Contract

`GlassSurface` is the only shared implementation point. It uses native blur on
iOS, a restrained translucent fallback on Android, and a readable fallback on
web. Keep `intensity` between 28 and 58 for application chrome.

The material must:

- have a visible edge highlight and a quiet fill;
- keep text and icons above 4.5:1 contrast where they are normal-size text;
- remain readable when Reduce Transparency is enabled;
- avoid more than three simultaneous glass containers in one viewport;
- never be used as a loading animation or decorative background.

## Typography

- Screen title: 22-24, semibold/bold.
- Section title: 15-17, semibold.
- Body: 15-16, regular.
- Supporting text: 12-13, only when it is not the sole carrier of meaning.
- Do not use negative letter spacing or viewport-scaled font sizes.

## Navigation

The bottom tab bar is a floating glass tool surface above the content and safe
area. Active state uses the accent color and icon shape change. The profile
switch hint stays secondary and must never compete with the five destinations.

Top bars should be compact, scroll-aware, and transparent until content needs a
stable contrast surface. Avoid duplicating identity data in every header.

## Accessibility And Performance

- Every interactive control needs an accessible label when its icon is not
  self-explanatory.
- Test dark/light themes, large text, Reduce Transparency, and keyboard-open
  states.
- Do not mount expensive blur or heavy screens during a touch callback.
- Preserve the existing deferred tab mounting and latest-tap-wins behavior.
- After visual changes run `npm run typecheck`, `npm run lint`, and the focused
  UI/theme tests before producing an iOS build.

## Change Workflow

1. Read this file before changing UI.
2. Implement through shared tokens and components first; add a screen-local
   style only when no token fits.
3. Verify the iPhone 16 and iPhone 16 Plus layouts before committing.
