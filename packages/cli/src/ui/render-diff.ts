// Output is a multi-line string ready for the scrollback writer. Layout
// mirrors Claude Code's StructuredDiff: per-line gutter with right-
// aligned line number + sigil, then syntax-highlighted code padded to
// fill the column so the red/green background reaches the right edge.
//
// Each rendered line is prefixed with RESULT_INDENT so the diff sits
// directly under the tool-call bullet in scrollback (`   ⎿  Added X
// lines, removed Y` header, then 6-space-indented diff body).
//
// Two render paths share the same gutter / column / highlight pipeline:
//   - update path (`renderHunks`): hunks with green/red bg + sigil
//   - create path (`renderCreatePreview`): first N lines of new content,
//     no diff bg (the whole file is "new" — bg coloring every row would
//     be visual noise), but same syntax highlighting and gutter style.
import { Chalk } from 'chalk'

import type { EditDiffHunk, EditDiffPayload } from '@tegent/core'

import { applyColor, detectLanguage, highlightLine } from './syntax-highlight.js'
import { sliceByWidth, visualWidth } from './text-width.js'
import { DIFF_ADDED_BG, DIFF_ADDED_FG, DIFF_REMOVED_BG, DIFF_REMOVED_FG, DIFF_TEXT_FG } from './theme.js'
import { RESULT_INDENT } from './utils.js'

const c = new Chalk({ level: 3 })

/** Cap an individual diff body's height. Multi-hunk patches with hundreds
 *  of lines aren't useful in scrollback (the user would scroll past most
 *  of it anyway); after the cap we collapse to a `… +N more lines` row.
 *  Matches Claude Code's behavior of clipping long structured diffs. */
const MAX_DIFF_LINES = 60

/** Cap on the create-mode content preview. Claude Code's
 *  FileWriteToolCreatedMessage uses MAX_LINES_TO_RENDER = 10; we follow
 *  the same number so a freshly-created package.json / config file shows
 *  enough to be useful but doesn't dominate the scrollback. */
const MAX_CREATE_PREVIEW_LINES = 10

/** Format the count summary line ("Added 3 lines, removed 1 line"). */
function formatCounts(p: EditDiffPayload): string {
  if (p.isCreate) {
    const n = p.additions
    return `Created ${c.bold(String(n))} ${n === 1 ? 'line' : 'lines'}`
  }
  const parts: string[] = []
  if (p.additions > 0) {
    parts.push(`Added ${c.bold(String(p.additions))} ${p.additions === 1 ? 'line' : 'lines'}`)
  }
  if (p.removals > 0) {
    const verb = parts.length > 0 ? 'removed' : 'Removed'
    parts.push(`${verb} ${c.bold(String(p.removals))} ${p.removals === 1 ? 'line' : 'lines'}`)
  }
  if (parts.length === 0) return 'No changes'
  return parts.join(', ')
}

/** Pick the largest visible line number across all hunks so every gutter
 *  is the same width — keeps the sigil column aligned across hunks. */
function maxLineNumber(hunks: EditDiffHunk[]): number {
  let max = 1
  for (const h of hunks) {
    const o = h.oldStart + h.oldLines - 1
    const n = h.newStart + h.newLines - 1
    if (o > max) max = o
    if (n > max) max = n
  }
  return max
}

/** Walk a hunk's `lines` array, assigning each line its file-relative
 *  number. Follows the standard unified-diff convention: `-` rows are
 *  numbered against the OLD file, `+` and context rows against the NEW
 *  file. Each counter advances independently so consecutive remove rows
 *  get distinct old-file numbers. */
function numberLines(h: EditDiffHunk): { sigil: ' ' | '+' | '-'; code: string; lineNum: number }[] {
  const out: { sigil: ' ' | '+' | '-'; code: string; lineNum: number }[] = []
  let oldN = h.oldStart
  let newN = h.newStart
  for (const raw of h.lines) {
    const sigil = raw[0] === '+' ? '+' : raw[0] === '-' ? '-' : ' '
    const code = raw.slice(1)
    if (sigil === '-') {
      out.push({ sigil, code, lineNum: oldN })
      oldN++
    } else if (sigil === '+') {
      out.push({ sigil, code, lineNum: newN })
      newN++
    } else {
      out.push({ sigil, code, lineNum: newN })
      oldN++
      newN++
    }
  }
  return out
}

/** Truncate a single code line so the rendered row fits the column. The
 *  width budget is the terminal width minus the indent and the gutter. We
 *  use a UTF ellipsis to mark the cut, matching the tool-input preview.
 *
 *  Both the fits-check and the slice operate on VISUAL columns, not JS
 *  string units. CJK / fullwidth chars take 2 cells but `length === 1`,
 *  so a length-based check would let a 50-char Chinese line slip past a
 *  100-cell budget while actually overshooting by 50 cells — the terminal
 *  would then wrap mid-row and produce a spurious blank below every diff
 *  line. */
function fitCode(code: string, width: number): string {
  if (visualWidth(code) <= width) return code
  if (width < 1) return ''
  return sliceByWidth(code, Math.max(0, width - 1)) + '…'
}

/**
 * Render the diff body. Returns a string with N lines (no leading or
 * trailing newline). Each line is already indented by RESULT_INDENT.
 *
 * `terminalWidth` is the full terminal width — the function reserves
 * RESULT_INDENT.length cells for the indent and computes the gutter +
 * code column from what remains. Falls back to 120 if the terminal width
 * is unknown / nonsensical.
 */
function renderHunks(payload: EditDiffPayload, terminalWidth: number): string[] {
  const cols = Math.max(40, terminalWidth)
  const lineNumWidth = Math.max(1, String(maxLineNumber(payload.hunks)).length)
  // Gutter format: " <num> <sigil> " — 1 leading space + num + 1 space +
  // sigil + 1 trailing space.
  const gutterWidth = lineNumWidth + 4
  // Reserve 1 trailing cell of safety: `-`/`+` rows pad their code column
  // with bg-colored spaces so the diff band reaches the right edge. If the
  // row's printable width hits exactly `cols`, the terminal enters
  // delayed-wrap state at the last column; Windows conhost / Windows
  // Terminal in some configurations counts that as a wrap and inserts a
  // phantom blank row below every padded `-`/`+` line. Leaving one cell
  // unpainted keeps the cursor strictly inside the row.
  const codeWidth = Math.max(1, cols - RESULT_INDENT.length - gutterWidth - 1)
  const lang = detectLanguage(payload.filePath)

  const out: string[] = []
  let emitted = 0
  let truncated = 0

  for (let hi = 0; hi < payload.hunks.length; hi++) {
    if (hi > 0) {
      // Hunk separator — Claude Code uses a dimmed `...` row.
      out.push(`${RESULT_INDENT}${c.gray('...')}`)
    }
    const hunk = payload.hunks[hi]!
    const numbered = numberLines(hunk)
    for (const { sigil, code, lineNum } of numbered) {
      if (emitted >= MAX_DIFF_LINES) {
        truncated++
        continue
      }
      emitted++

      const numStr = String(lineNum).padStart(lineNumWidth)
      const fitted = fitCode(code, codeWidth)
      // Pad against the RAW (pre-highlight) text so the colored bg fills
      // exactly to the right edge. Highlighting only adds escape codes —
      // it doesn't change the visible character count. Use visual width
      // (CJK chars are 2 cells wide despite `length === 1`); a length-
      // based padding would over-pad by `visualWidth - length` and make
      // the row wrap into a blank visual line below every CJK diff row.
      const padding = ' '.repeat(Math.max(0, codeWidth - visualWidth(fitted)))
      const gutter = ` ${numStr} ${sigil} `
      // Syntax highlighting is applied to CONTEXT rows only. On +/- rows
      // we render plain text on top of the diff bg — multi-color
      // highlighting on top of a saturated red/green band fights the bg
      // visually and reads as noise. Claude Code's fallback diff renders
      // diff bodies as plain text on bg for the same reason; the bg
      // alone communicates add/remove and the surrounding context lines
      // give the eye full-color anchors.
      let styled: string
      if (sigil === '+') {
        // `+` row: bg + decorated gutter + syntax-highlighted code.
        // CC always highlights `+` lines (they ARE the new code).
        // We pre-paint the gutter in the add-decoration color
        // BEFORE wrapping the row in bg, so the colored fg sticks.
        // DIFF_TEXT_FG is threaded through so unmatched chars (`;`, `(`,
        // `)`, `{`, `}`) and undecorated identifiers (e.g. `log` in
        // `console.log`) get CC's bright cream instead of
        // the terminal default white.
        const code = highlightLine(fitted, lang, DIFF_TEXT_FG)
        const coloredGutter = c.hex(DIFF_ADDED_FG)(gutter)
        styled = c.bgHex(DIFF_ADDED_BG)(coloredGutter + code + padding)
      } else if (sigil === '-') {
        // `-` row: bg + decorated gutter + PLAIN code (no syntax
        // highlighting, ever). CC's color-diff/index.ts:916-918 always
        // passes the `-` line through `defaultStyle(theme)` instead of
        // highlightLine. Multi-color fg on top of the saturated red
        // bg also fights itself visually; plain text reads as "this
        // is going away" more cleanly. We DO apply DIFF_TEXT_FG though —
        // it's how CC's `defaultStyle` makes the deleted text visibly
        // brighter than terminal default.
        const plainCode = applyColor(fitted, DIFF_TEXT_FG)
        const coloredGutter = c.hex(DIFF_REMOVED_FG)(gutter)
        styled = c.bgHex(DIFF_REMOVED_BG)(coloredGutter + plainCode + padding)
      } else {
        // Context row: full syntax highlighting, no bg, gutter in
        // default fg (matches CC's addLineNumber path for marker===' ').
        // DIFF_TEXT_FG here keeps brightness consistent across context and
        // +/- rows — CC paints all three from the same Theme.foreground.
        const highlighted = highlightLine(fitted, lang, DIFF_TEXT_FG)
        styled = gutter + highlighted + padding
      }
      out.push(`${RESULT_INDENT}${styled}`)
    }
  }

  if (truncated > 0) {
    out.push(`${RESULT_INDENT}${c.gray(`… +${truncated} more line${truncated === 1 ? '' : 's'}`)}`)
  }

  return out
}

/**
 * Render the first ~10 lines of newly-created file content as a preview
 * block. Same gutter style + syntax highlight as the update path — what
 * distinguishes create from update visually is the absence of the diff
 * bg: bg-coloring every row green for a brand-new file would be visual
 * noise without communicating any information (there's nothing to
 * compare against). Truncated tail collapses to `… +N lines`.
 */
function renderCreatePreview(filePath: string, content: string, terminalWidth: number): string[] {
  const cols = Math.max(40, terminalWidth)
  const allLines = content.split('\n')
  // Drop a single trailing empty line — most file content ends with `\n`,
  // splitting yields an empty string we don't want to render.
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  if (allLines.length === 0) return []

  const visible = allLines.slice(0, MAX_CREATE_PREVIEW_LINES)
  const truncated = allLines.length - visible.length
  const lineNumWidth = Math.max(1, String(allLines.length).length)
  const gutterWidth = lineNumWidth + 2 // " <num> "
  const codeWidth = Math.max(1, cols - RESULT_INDENT.length - gutterWidth)
  const lang = detectLanguage(filePath)

  const out: string[] = []
  for (let i = 0; i < visible.length; i++) {
    const numStr = String(i + 1).padStart(lineNumWidth)
    const fitted = fitCode(visible[i] ?? '', codeWidth)
    const highlighted = highlightLine(fitted, lang)
    out.push(`${RESULT_INDENT}${c.gray(` ${numStr} `)}${highlighted}`)
  }
  if (truncated > 0) {
    out.push(`${RESULT_INDENT}${c.gray(`… +${truncated} ${truncated === 1 ? 'line' : 'lines'}`)}`)
  }
  return out
}

/**
 * Render the full diff block (counts header + hunk body or content
 * preview) as the body of a tool-call result row. The first line is meant
 * to follow the `   ⎿  ` prefix that stdout-writer emits, so we DON'T
 * prepend the prefix here — the caller stitches everything together.
 *
 * Returns:
 *   - line[0]: counts summary (e.g. "Added 3 lines, removed 1 line" /
 *              "Created 20 lines")
 *   - line[1..]: diff hunks (update path) or content preview (create path)
 *
 * Update payloads with no hunks (timed-out diff) collapse to the header
 * only — there's no patch to render.
 */
export function renderEditDiff(payload: EditDiffPayload, terminalWidth: number): string[] {
  const header = formatCounts(payload)
  if (payload.isCreate) {
    if (!payload.content) return [header]
    return [header, ...renderCreatePreview(payload.filePath, payload.content, terminalWidth)]
  }
  if (payload.hunks.length === 0) return [header]
  return [header, ...renderHunks(payload, terminalWidth)]
}
