// 终端 Markdown 渲染：marked 只负责 token 化，这里把 token 树映射成 Ink 元素。
// 不选 marked-terminal：它输出带 ANSI 转义的整段字符串，嵌进 Ink 的 <Text> 会破坏
// 宽度测量与布局；映射成 Box/Text 才能和消息流、流式刷新无缝混排。
import { useMemo, type ReactNode } from "react";

import { marked, type Token, type Tokens } from "marked";
import { Box, Text } from "ink";

/** 把行内 token 列表拼成纯文本，用于表格列宽计算和链接地址去重。 */
function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    const tok = t as Tokens.Generic;
    if (Array.isArray(tok.tokens) && tok.tokens.length > 0) {
      out += plainText(tok.tokens);
    } else if (typeof tok.text === "string") {
      out += tok.text;
    }
  }
  return out;
}

/** 终端显示宽度：CJK / 全角 / 常见 emoji 按 2 列计，表格对齐用。 */
function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首、注音、假名
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul 音节
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
      (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
      (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII / 假名
      (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
      (code >= 0x1f300 && code <= 0x1f64f) || // 常见 emoji 区块
      (code >= 0x20000 && code <= 0x3fffd); // CJK 扩展
    width += wide ? 2 : 1;
  }
  return width;
}

/** 行内 token → ReactNode 列表（作为 <Text> 的 children）。 */
function renderInline(tokens: Token[] | undefined): ReactNode[] {
  if (!tokens) return [];
  const out: ReactNode[] = [];
  tokens.forEach((t, i) => {
    switch (t.type) {
      case "strong":
        out.push(
          <Text key={i} bold>
            {renderInline((t as Tokens.Strong).tokens)}
          </Text>,
        );
        break;
      case "em":
        out.push(
          <Text key={i} italic>
            {renderInline((t as Tokens.Em).tokens)}
          </Text>,
        );
        break;
      case "del":
        out.push(
          <Text key={i} strikethrough>
            {renderInline((t as Tokens.Del).tokens)}
          </Text>,
        );
        break;
      case "codespan": {
        const span = t as Tokens.Codespan;
        out.push(
          <Text key={i} color="cyanBright">{` ${span.text} `}</Text>,
        );
        break;
      }
      case "link": {
        const link = t as Tokens.Link;
        out.push(
          <Text key={i} color="cyan" underline>
            {renderInline(link.tokens)}
          </Text>,
        );
        // 链接文本和地址相同时（autolink）不重复显示地址。
        if (link.href && plainText(link.tokens) !== link.href) {
          out.push(
            <Text key={`${i}-href`} dimColor>{` (${link.href})`}</Text>,
          );
        }
        break;
      }
      case "image": {
        const image = t as Tokens.Image;
        out.push(
          <Text key={i} dimColor>{`[图片: ${image.text || image.href}]`}</Text>,
        );
        break;
      }
      case "br":
        out.push("\n");
        break;
      case "html":
        out.push(
          <Text key={i} dimColor>{(t as Tokens.Generic).raw ?? ""}</Text>,
        );
        break;
      default: {
        // text / escape：有嵌套行内 token 就递归，否则直接用 text。
        const tok = t as Tokens.Generic;
        if (Array.isArray(tok.tokens) && tok.tokens.length > 0) {
          out.push(<Text key={i}>{renderInline(tok.tokens)}</Text>);
        } else if (typeof tok.text === "string") {
          out.push(<Text key={i}>{tok.text}</Text>);
        }
        break;
      }
    }
  });
  return out;
}

/** 列表项内容。marked 的坑：非 loose 列表首 token 是 text，行内内容在其 tokens 上；
 *  loose 列表则是普通块级 token（space/paragraph/list 混排）。 */
function renderListItemBody(item: Tokens.ListItem): ReactNode[] {
  return (
    item.tokens
      // task 列表的 checkbox 状态已由前缀 [x]/[ ] 渲染，跳过它的独立 token。
      .filter((t) => t.type !== "checkbox")
      .map((t, i) => {
        if (t.type === "text") {
          const tok = t as Tokens.Text;
          const children =
            Array.isArray(tok.tokens) && tok.tokens.length > 0
              ? renderInline(tok.tokens)
              : tok.text;
          return <Text key={i}>{children}</Text>;
        }
        return renderBlock(t, i);
      })
  );
}

/** 列表：每项「前缀 + 内容列」两栏，嵌套子列表/多段落在内容列里自然缩进。 */
function renderList(list: Tokens.List, key: React.Key): ReactNode {
  return (
    <Box key={key} flexDirection="column">
      {list.items.map((item, i) => {
        const prefix = item.task
          ? item.checked
            ? "[x] "
            : "[ ] "
          : list.ordered
            ? `${Number(list.start ?? 1) + i}. `
            : "• ";
        return (
          <Box key={i} flexDirection="row">
            <Text dimColor>{prefix}</Text>
            <Box flexDirection="column">{renderListItemBody(item)}</Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** 表格：列宽取各列单元格纯文本的最大显示宽，表头加粗青色 + dim 分隔线。 */
function renderTable(table: Tokens.Table, key: React.Key): ReactNode {
  const allRows = [table.header, ...table.rows];
  const widths = table.header.map((_, col) =>
    Math.max(...allRows.map((row) => displayWidth(plainText(row[col]?.tokens)))),
  );

  const justifyContentFor = (
    align: string | null,
  ): "center" | "flex-end" | "flex-start" =>
    align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";

  const renderRow = (
    row: Tokens.TableCell[],
    isHeader: boolean,
    rowKey: React.Key,
  ) => (
    <Box key={rowKey}>
      {row.map((cell, i) => (
        <Box key={i} flexDirection="row">
          {i > 0 ? <Text dimColor> │ </Text> : null}
          <Box
            width={widths[i]}
            justifyContent={justifyContentFor(table.align[i] ?? null)}
          >
            <Text
              bold={isHeader}
              {...(isHeader ? { color: "cyan" as const } : {})}
            >
              {renderInline(cell.tokens)}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );

  return (
    <Box key={key} flexDirection="column">
      {renderRow(table.header, true, "header")}
      <Text dimColor>{widths.map((w) => "─".repeat(w)).join("─┼─")}</Text>
      {table.rows.map((row, i) => renderRow(row, false, i))}
    </Box>
  );
}

/** 块级 token → Ink 元素。 */
function renderBlock(token: Token, key: React.Key): ReactNode {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      // h1 品牌橙呼应输入框边框，h2 青色，h3 默认色加粗，h4 及以下再压暗。
      const color =
        heading.depth === 1
          ? "#D97757"
          : heading.depth === 2
            ? "cyan"
            : undefined;
      return (
        <Text
          key={key}
          bold
          dimColor={heading.depth >= 4}
          {...(color ? { color } : {})}
        >
          {renderInline(heading.tokens)}
        </Text>
      );
    }
    case "paragraph":
      return (
        <Text key={key}>
          {renderInline((token as Tokens.Paragraph).tokens)}
        </Text>
      );
    case "code": {
      const code = token as Tokens.Code;
      return (
        <Box key={key} flexDirection="column">
          {code.lang ? <Text dimColor>{code.lang}</Text> : null}
          {/* 只保留左侧竖条（Ink 的边框四边默认全开，需显式关掉其余三边）。 */}
          <Box
            borderStyle="single"
            borderLeft
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor="gray"
            paddingLeft={1}
          >
            <Text>{code.text.replace(/\n$/, "")}</Text>
          </Box>
        </Box>
      );
    }
    case "blockquote": {
      const quote = token as Tokens.Blockquote;
      return (
        <Box key={key}>
          <Text color="gray">│ </Text>
          <Box flexDirection="column">
            {quote.tokens.map((t, i) => renderBlock(t, i))}
          </Box>
        </Box>
      );
    }
    case "list":
      return renderList(token as Tokens.List, key);
    case "hr":
      // 同代码块：Ink 边框四边默认全开，只留底边才是分隔线。
      return (
        <Box
          key={key}
          borderStyle="single"
          borderBottom
          borderTop={false}
          borderLeft={false}
          borderRight={false}
          borderDimColor
        />
      );
    case "table":
      return renderTable(token as Tokens.Table, key);
    case "space":
      return null;
    case "html":
      return (
        <Text key={key} dimColor>{(token as Tokens.Generic).raw ?? ""}</Text>
      );
    default: {
      // 其余块级 token（如 loose 列表里的 text）：有行内内容按行内兜底渲染。
      const tok = token as Tokens.Generic;
      if (Array.isArray(tok.tokens) && tok.tokens.length > 0) {
        return <Text key={key}>{renderInline(tok.tokens)}</Text>;
      }
      return (
        <Text key={key}>
          {typeof tok.text === "string" ? tok.text : (tok.raw ?? "")}
        </Text>
      );
    }
  }
}

/** 把 Markdown 源文本渲染成 Ink 元素树；空内容返回 null。 */
export function Markdown({ source }: { source: string }) {
  // 流式追加时 source 引用变化才重新 lexer；已完成的历史消息 memo 直接命中。
  const tokens = useMemo(() => marked.lexer(source), [source]);
  if (tokens.length === 0) return null;
  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => renderBlock(token, i))}
    </Box>
  );
}
