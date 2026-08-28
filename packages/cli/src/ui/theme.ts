// ─── UI colors ────────────────────────────────────────────────────────
//
// Static color constants for the whole terminal UI. No theme switching —
// this project is a minimal implementation with one fixed (dark) look.
//
// Palette mirrors Claude Code's dark theme (`src/utils/theme.ts` darkTheme).
// All values are hex strings so Ink <Text color={...}> renders them on any
// modern 24-bit terminal.

/** Primary accent — Claude brand orange (`claude = rgb(215,119,87)`) */
export const ACCENT = '#d77757'

/** Muted accent — medium gray, used for secondary labels in the status bar */
export const ACCENT_DIM = '#999999'

/** System spinner blue (`claudeBlue_FOR_SYSTEM_SPINNER = rgb(147,165,255)`) */
export const SPINNER_BLUE = '#93a5ff'

/** Light blue-purple — permission dialogs, suggestions, highlights (`permission = rgb(153,204,255)`) */
export const BLUE_PURPLE = '#99ccff'

/** Success / completed / diff-added (`success = rgb(78,186,101)`) */
export const SUCCESS = '#4eba65'

/** Warning / permission prompt / pending (`warning = rgb(255,193,7)`) */
export const WARNING = '#ffc107'

/** Error / denied / diff-removed (`error = rgb(255,107,128)`) */
export const ERROR = '#ff6b80'

/** Muted elements — uses named ANSI gray for broad compatibility */
export const DIM = 'gray'

/** Subtle dark gray for borders/backgrounds (`subtle = rgb(80,80,80)`) */
export const SUBTLE = '#505050'

/** Prompt input top/bottom rules (`promptBorder = rgb(136,136,136)`) */
export const PROMPT_BORDER = '#888888'

// ─── Diff colors ───
//
// Fixed dark-mode diff styling. Values match Claude Code's dark
// `buildTheme()` (native-ts/color-diff/index.ts).

/** Background for `+` rows in edit diffs */
export const DIFF_ADDED_BG = '#022800'

/** Background for `-` rows in edit diffs */
export const DIFF_REMOVED_BG = '#3d0100'

/** Gutter (line number + sigil) fg for `+` rows — saturated so it pops
 *  off the near-black bg; without it the gutter is invisible at the
 *  depths used for the diff bg. */
export const DIFF_ADDED_FG = '#50c850'

/** Gutter fg for `-` rows */
export const DIFF_REMOVED_FG = '#dc5a5a'

/** Default fg for unhighlighted text inside diff rows. Mirrors CC's
 *  `Theme.foreground` (color-diff/index.ts:303) — without this,
 *  unmatched chars and plain `-` lines fall back to the terminal's
 *  default white (typically `#cccccc`), so diff rows look noticeably
 *  dimmer than CC's. */
export const DIFF_TEXT_FG = '#f8f8f2'
