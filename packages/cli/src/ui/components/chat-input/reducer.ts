// ChatInput 中用于原子更新文本和光标位置的 reducer。
//
// 输入框缓冲区的所有修改都通过 `useReducer(inputReducer)` 完成。
// 这样一次按键如果既修改文本又移动光标，就会作为一次状态转移提交。
// UI 不会出现“文本已经变了，但光标还停在旧位置”的中间帧。

/**
 * 输入框的本地状态。
 */
export interface InputState {
  /**
   * 输入框里的完整文本。
   */
  text: string

  /**
   * 当前光标所在位置。
   *
   * 这里用字符串下标表示，范围通常是 0 到 `text.length`。
   */
  cursor: number
}

/**
 * 输入框 reducer 支持的动作。
 */
export type InputAction =
  | { type: 'INSERT'; pos: number; chunk: string } // 在指定位置插入一段文本。
  | { type: 'BACKSPACE_REF'; pos: number; deleteCount: number } // 从光标前删除指定数量的字符或占位符。
  | { type: 'DELETE'; pos: number } // 删除指定位置上的一个字符。
  | { type: 'SET_CURSOR'; cursor: number } // 只更新光标位置。
  | { type: 'SET_TEXT'; text: string; cursor: number } // 同时替换完整文本和光标位置。
  | { type: 'RESET' } // 清空文本并把光标重置到开头。

/**
 * 根据输入动作计算下一份输入框状态。
 *
 * @param state - 当前输入框状态。
 * @param action - 本次要应用的输入动作。
 * @returns 应用动作后的下一份输入框状态。
 */
export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'INSERT': {
      const { pos, chunk } = action // 取出插入位置和要插入的文本片段。
      return {
        text: state.text.slice(0, pos) + chunk + state.text.slice(pos), // 把原文本拆成插入点前后两段，中间拼入 chunk。
        cursor: pos + chunk.length, // 插入后光标移动到新插入文本的末尾。
      }
    }
    case 'BACKSPACE_REF': {
      const { pos, deleteCount } = action // 取出当前光标位置和要向前删除的字符数量。
      if (pos === 0) return state // 光标已经在开头时，Backspace 不产生任何变化。
      return {
        text: state.text.slice(0, pos - deleteCount) + state.text.slice(pos), // 删除 `[pos - deleteCount, pos)` 这一段文本。
        cursor: pos - deleteCount, // 删除后光标回退到被删除片段的起点。
      }
    }
    case 'DELETE': {
      const { pos } = action // 取出要删除的字符位置。
      if (pos >= state.text.length) return state // 光标在文本末尾或越界时，Delete 不产生任何变化。
      return { text: state.text.slice(0, pos) + state.text.slice(pos + 1), cursor: state.cursor } // 删除 pos 位置字符，光标位置保持不变。
    }
    case 'SET_CURSOR':
      return state.cursor === action.cursor ? state : { ...state, cursor: action.cursor } // 光标没变时复用旧状态，否则只替换 cursor。
    case 'SET_TEXT':
      return { text: action.text, cursor: action.cursor } // 用调用方给出的文本和光标位置完整替换当前状态。
    case 'RESET':
      return { text: '', cursor: 0 } // 清空输入框，并把光标放回开头。
    default:
      return state // 理论上不会走到这里；保留兜底以返回当前状态。
  }
}
