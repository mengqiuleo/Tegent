// ChatInput：负责「消息区 + 交互问题弹层 + 输入框」三块。
// 键盘只处理基础的输入、退格、左右移动、Enter 提交、Esc 中断、Ctrl+C；
// 有挂起问题（权限确认/计划审批/askUser）时切换到问题交互：候选选择或自由输入。
import { useEffect, useMemo, useState } from "react";

import { Box, Text, useInput, useStdin } from "ink";
import type { Key } from "ink";

import type { DisplayMessage, PendingQuestion } from "../hooks/use-agent.js";

import { Markdown } from "./Markdown.js";

/** 最多直接渲染的历史消息数量，避免长会话把输入框挤出屏幕。 */
const MAX_VISIBLE_MESSAGES = 30;

/** 计划审批弹层里最多展示的计划行数，超出部分折叠提示。 */
const MAX_PLAN_LINES = 20;

/** 权限弹层里工具输入摘要的最大长度。 */
const MAX_PERMISSION_SUMMARY = 400;

interface ChatInputProps {
  /** 滚动区消息。 */
  messages: readonly DisplayMessage[];
  /** 提交入口；App 在这里调用 useAgent.submit。 */
  onSubmit: (text: string) => void;
  /** Ctrl+C 入口；App 负责双击退出判定。 */
  onInterrupt: () => void;
  /** loading 时 Esc 的取消入口。 */
  onEscapeCancel?: () => void;
  /** 当前是否有 agent turn 在执行。 */
  isLoading?: boolean;
  /** 输入框下方的短提示。 */
  notice?: string | null;
  /** 错误提示。 */
  errorMessage?: string | null;
  /** 挂起中的交互问题（权限确认 / 计划审批 / askUser）。 */
  question?: PendingQuestion | null;
  /** 用户回答挂起问题的入口。 */
  onAnswer?: (value: string) => void;
}

/** 弹层里的一个候选。value 是回传给 useAgent 的答案编码。 */
interface QuestionChoice {
  value: string;
  label: string;
  description?: string;
}

/** 按问题类型展开候选列表；askUser 无候选时返回空（走自由输入）。 */
function questionChoices(q: PendingQuestion): QuestionChoice[] {
  if (q.kind === "permission") {
    return [
      { value: "yes", label: "Yes — allow once" },
      { value: "always", label: "Always — allow for this session" },
      { value: "no", label: "No — deny" },
    ];
  }
  if (q.kind === "plan") {
    return [
      { value: "approve", label: "Approve — exit plan mode and start implementing" },
      { value: "reject", label: "Reject — stay in plan mode and keep planning" },
    ];
  }
  if (q.options && q.options.length > 0) {
    return q.options.map((o) => ({ value: o.label, label: o.label, description: o.description }));
  }
  return [];
}

/** 权限弹层的工具输入摘要：shell 显示命令，writeFile/edit 显示路径，其余 JSON。 */
function summarizePermissionInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "shell") return String(input.command ?? "");
  if (toolName === "writeFile" || toolName === "edit") return String(input.filePath ?? "");
  const json = JSON.stringify(input);
  return json.length > MAX_PERMISSION_SUMMARY ? `${json.slice(0, MAX_PERMISSION_SUMMARY)}...` : json;
}

/** 根据消息角色生成左侧短标签。 */
function renderLabel(msg: DisplayMessage): string {
  if (msg.role === "user") return "you";
  if (msg.role === "tool") return "tool";
  if (msg.role === "system") return "system";
  return "assistant";
}

/** 渲染一条消息：标签一行 + 正文逐行。 */
function MessageBlock({ msg }: { msg: DisplayMessage }) {
  const label = renderLabel(msg);
  const labelColor =
    msg.role === "user"
      ? "cyan"
      : msg.role === "tool"
        ? "gray"
        : msg.role === "system"
          ? "yellow"
          : undefined;

  // assistant 输出是 Markdown，交给 Markdown 组件渲染；空内容（流式刚开始的占位）不渲染。
  if (msg.role === "assistant") {
    if (msg.content.trim().length === 0) return null;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>{label}</Text>
        <Markdown source={msg.content} />
      </Box>
    );
  }

  const lines = msg.content.length > 0 ? msg.content.trimEnd().split("\n") : [];

  if (lines.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {labelColor ? (
        <Text color={labelColor}>{label}</Text>
      ) : (
        <Text>{label}</Text>
      )}
      {lines.map((line, idx) => (
        <Text key={`${msg.id}-line-${idx}`}>{line}</Text>
      ))}
    </Box>
  );
}

/** 挂起问题的弹层：标题 + 详情（工具输入/计划正文）+ 候选列表或自由输入提示。 */
function QuestionBlock({
  question,
  choices,
  selectedIndex,
}: {
  question: PendingQuestion;
  choices: QuestionChoice[];
  selectedIndex: number;
}) {
  const freeText = choices.length === 0;
  const title =
    question.kind === "permission"
      ? `Allow ${question.toolName}?`
      : question.kind === "plan"
        ? "Plan approval requested"
        : question.question;

  const detailLines: string[] = [];
  if (question.kind === "permission") {
    detailLines.push(summarizePermissionInput(question.toolName, question.input));
  } else if (question.kind === "plan") {
    const lines = question.planText.split("\n");
    detailLines.push(...lines.slice(0, MAX_PLAN_LINES));
    if (lines.length > MAX_PLAN_LINES) {
      detailLines.push(`... (${lines.length - MAX_PLAN_LINES} more lines not shown)`);
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1}>
      <Text bold color="magenta">
        {title}
      </Text>
      {detailLines.map((line, idx) => (
        <Text key={`detail-${idx}`} color="gray">
          {line.length > 0 ? line : " "}
        </Text>
      ))}
      {choices.map((choice, idx) => (
        <Box key={choice.value} flexDirection="column">
          {idx === selectedIndex ? (
            <Text color="green">{`❯ ${idx + 1}. ${choice.label}`}</Text>
          ) : (
            <Text>{`  ${idx + 1}. ${choice.label}`}</Text>
          )}
          {choice.description ? (
            <Text color="gray">{`    ${choice.description}`}</Text>
          ) : null}
        </Box>
      ))}
      <Text color="gray">
        {freeText
          ? "Type your answer below, Enter to send · Esc to skip"
          : "↑/↓ or 1-9 to select · Enter to confirm · Esc to deny"}
      </Text>
    </Box>
  );
}

export function ChatInput({
  messages,
  onSubmit,
  onInterrupt,
  onEscapeCancel,
  isLoading = false,
  notice,
  errorMessage,
  question,
  onAnswer,
}: ChatInputProps) {
  // 单行输入：文本 + 光标位置，光标渲染为反色字符。
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  // 问题弹层的当前选中候选；问题切换（id 变化）时复位。
  const [selectedIndex, setSelectedIndex] = useState(0);
  // 非 TTY（管道/重定向）下 stdin 不支持 raw mode，useInput 必须停用，
  // 否则 Ink 会直接抛错；此时输入框只读，仍能渲染消息流。
  const { isRawModeSupported } = useStdin();

  const choices = useMemo(() => (question ? questionChoices(question) : []), [question]);
  // askUser 无候选时是自由输入问题，复用主输入框收集答案。
  const freeTextQuestion = question !== undefined && question !== null && choices.length === 0;

  useEffect(() => {
    setSelectedIndex(0);
  }, [question?.id]);

  /** 普通文本编辑按键（退格/移动/插入）；平时输入和问题的自由输入共用。 */
  const applyEditKey = (input: string, key: Key) => {
    if (key.backspace || key.delete) {
      setText((t) => t.slice(0, Math.max(0, cursor - 1)) + t.slice(cursor));
      setCursor((c) => Math.max(0, c - 1));
      return;
    }

    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor((c) => Math.min(text.length, c + 1));
      return;
    }

    // 普通文本插入光标处；过滤掉控制字符。
    if (
      input &&
      !key.ctrl &&
      !key.meta &&
      !key.escape &&
      !key.tab &&
      !key.return
    ) {
      setText((t) => t.slice(0, cursor) + input + t.slice(cursor));
      setCursor((c) => c + input.length);
    }
  };

  /** 挂起问题时的按键处理：候选选择或自由输入。 */
  const handleQuestionKey = (input: string, key: Key) => {
    if (!question || !onAnswer) return;

    // Esc：按保守答案直接关闭问题（拒绝/驳回/跳过）。
    if (key.escape) {
      onAnswer(question.kind === "permission" ? "no" : question.kind === "plan" ? "reject" : "");
      if (freeTextQuestion) {
        setText("");
        setCursor(0);
      }
      return;
    }

    if (key.return) {
      if (freeTextQuestion) {
        onAnswer(text);
        setText("");
        setCursor(0);
      } else {
        const choice = choices[selectedIndex];
        if (choice) onAnswer(choice.value);
      }
      return;
    }

    if (freeTextQuestion) {
      applyEditKey(input, key);
      return;
    }

    if (key.upArrow || key.leftArrow) {
      setSelectedIndex((i) => (i - 1 + choices.length) % choices.length);
      return;
    }
    if (key.downArrow || key.rightArrow) {
      setSelectedIndex((i) => (i + 1) % choices.length);
      return;
    }

    // 数字键直接选择对应候选。
    const digit = Number.parseInt(input, 10);
    if (input.length === 1 && !Number.isNaN(digit) && digit >= 1 && digit <= choices.length) {
      onAnswer(choices[digit - 1]!.value);
      return;
    }

    // 权限问题的 y/a/n 快捷键。
    if (question.kind === "permission") {
      const lower = input.toLowerCase();
      if (lower === "y") onAnswer("yes");
      else if (lower === "a") onAnswer("always");
      else if (lower === "n") onAnswer("no");
    }
  };

  useInput(
    (input, key) => {
      // Ctrl+C：App 负责第一次取消（同时按保守答案放行挂起的问题）、第二次退出。
      if ((key.ctrl && input.toLowerCase() === "c") || input === "\x03") {
        onInterrupt();
        return;
      }

      // 挂起问题优先：按键都服务问题本身，不进普通输入逻辑。
      if (question && onAnswer) {
        handleQuestionKey(input, key);
        return;
      }

      if (key.return) {
        const trimmed = text.trim();
        if (trimmed && !isLoading) {
          onSubmit(trimmed);
          setText("");
          setCursor(0);
        }
        return;
      }

      if (key.escape) {
        if (isLoading && onEscapeCancel) onEscapeCancel();
        return;
      }

      applyEditKey(input, key);
      // 注意：非 TTY 下 stdin.isTTY 是 undefined 而不是 false，
      // 而 Ink 内部用 `isActive === false` 严格判断，undefined 会穿透并触发 setRawMode 崩溃，
      // 所以这里必须归一成真正的布尔值。
    },
    { isActive: isRawModeSupported === true },
  );

  return (
    <Box flexDirection="column">
      {/* 消息区：只渲染尾部一段，避免巨量消息撑爆动态区域。 */}
      <Box flexDirection="column">
        {messages.slice(-MAX_VISIBLE_MESSAGES).map((msg) => (
          <MessageBlock key={msg.id} msg={msg} />
        ))}
      </Box>

      {/* 挂起中的交互问题（权限确认 / 计划审批 / askUser）。 */}
      {question ? (
        <QuestionBlock question={question} choices={choices} selectedIndex={selectedIndex} />
      ) : null}

      {/* 错误提示。 */}
      {errorMessage ? <Text color="red">Error: {errorMessage}</Text> : null}

      {/* agent 执行中显示 spinner 提示；有问题挂起时，问题本身就是当前活动。 */}
      {isLoading && !question ? <Text color="gray">Thinking...</Text> : null}

      {/* 主输入框：光标前文本、反色光标字符、光标后文本分三段渲染。
          自由输入问题挂起时，这个框就是答题框。 */}
      <Box
        borderStyle="single"
        borderColor={isLoading ? "gray" : "#D97757"}
        paddingX={1}
      >
        <Text color="cyan">› </Text>
        <Text>{text.slice(0, cursor)}</Text>
        <Text inverse>{text[cursor] ?? " "}</Text>
        <Text>{text.slice(cursor + 1)}</Text>
      </Box>

      {/* 底部短提示，目前只用于 “Press Ctrl+C again to exit”。 */}
      {notice ? <Text color="yellow">{notice}</Text> : null}
    </Box>
  );
}
