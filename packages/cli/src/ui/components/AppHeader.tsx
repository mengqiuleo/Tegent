import { Chalk } from "chalk";

const c = new Chalk({ level: 3 });

const ACCENT = "#D97757";

const GLYPHS: Record<string, string[]> = {
  T: ["█████", " ██  ", " ██  ", " ██  ", " ██  "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  G: [" ████", "█    ", "█  ██", "█   █", " ████"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
};

const LOGO_WORD = "TEGENT";
const LOGO_ROWS = 5;
const LOGO_W = LOGO_WORD.length * 5 + (LOGO_WORD.length - 1); // 35

function renderLogoRows(): string[] {
  const rows = Array.from({ length: LOGO_ROWS }, () => "");
  for (const ch of LOGO_WORD) {
    const glyph = GLYPHS[ch] ?? [];
    for (let i = 0; i < LOGO_ROWS; i++) {
      rows[i] = (rows[i] ?? "") + (glyph[i] ?? "") + " ";
    }
  }
  return rows.map((row) => row.trimEnd());
}

export function getHeaderRowCount(modelId: string): number {
  return renderHeader(modelId).split("\n").length - 1; // final '\n' adds one empty split
}

export function renderHeader(modelId: string): string {
  const cols = process.stdout.columns ?? 80;

  const [providerRaw, ...modelParts] = modelId.split(":");
  const provider = providerRaw ?? modelId;
  const modelName = modelParts.join(":") || modelId;

  const isMac = process.platform === "darwin";
  const abortKey = isMac ? "⌃C" : "Ctrl+C";
  const newlineHint = isMac
    ? "⌥⏎ or \\⏎ for newline"
    : "Alt+Enter or \\+Enter for newline";

  const versionText = "v0.0.1";
  const modelText = `${provider} / ${modelName}`;
  const taglineText = "terminal coding agent";

  const modelLine = `${c.hex(ACCENT)(provider)} ${c.dim("/")} ${c.hex(ACCENT).bold(modelName)}`;

  const hintLine = ` ${c.dim(
    `Type ${c.hex(ACCENT)("/help")} for commands, ${abortKey} to abort, ${newlineHint}`,
  )}`;

  const panelW = Math.max(
    versionText.length,
    modelText.length,
    taglineText.length,
  );
  const sideBySide = cols >= 2 + LOGO_W + 5 + panelW;
  const useBlockLogo = cols >= 2 + LOGO_W + 1;

  const lines: string[] = [];

  if (!useBlockLogo) {
    // Very narrow terminal: plain text logo, everything stacked.
    lines.push(` ${c.hex(ACCENT).bold(LOGO_WORD)} ${c.dim(versionText)}`);
    lines.push(` ${modelLine}`);
  } else {
    const logoRows = renderLogoRows().map(
      (row) => `  ${c.hex(ACCENT).bold(row.padEnd(LOGO_W))}`,
    );

    if (sideBySide) {
      const panels = [c.dim(versionText), modelLine, c.dim(taglineText)];
      for (let i = 0; i < LOGO_ROWS; i++) {
        const panel = panels[i - 1];
        lines.push(
          (logoRows[i] ?? "") +
            (panel === undefined
              ? ""
              : `  ${c.hex(ACCENT).dim("│")}  ${panel}`),
        );
      }
    } else {
      lines.push(
        ...logoRows,
        ` ${c.dim(versionText)} ${c.dim("·")} ${modelLine}`,
      );
    }
  }

  lines.push(hintLine, "");

  return lines.join("\n") + "\n";
}

export function printHeader(modelId: string): void {
  const rows = process.stdout.rows ?? 25;
  if (process.stdout.isTTY && rows > 1) {
    process.stdout.write("\n".repeat(rows - 1) + "\x1b[H");
  }
  process.stdout.write(renderHeader(modelId));
}
