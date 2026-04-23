/**
 * Wework Message Sender
 *
 * 企业微信消息发送工具（用于 WebSocket 长连接模式）。
 */

import type { RunResponse } from '../../agents/types.js';
import { contextUsagePercent } from '../../utils/context.js';

/**
 * 格式化统计信息
 */
function formatStats(response: RunResponse): string | null {
  const parts: string[] = [];
  if (response.model) parts.push(response.model);
  if (response.elapsedMs != null) parts.push(`${(response.elapsedMs / 1000).toFixed(1)}s`);
  if (response.inputTokens != null) parts.push(`${response.inputTokens} in`);
  if (response.outputTokens != null) parts.push(`${response.outputTokens} out`);
  if (response.costUsd != null) parts.push(`$${response.costUsd.toFixed(4)}`);
  const ctxPct = contextUsagePercent(response.inputTokens, response.contextWindow, response.model);
  if (ctxPct != null) parts.push(`ctx ${ctxPct}%`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * 构建 Markdown 消息内容
 *
 * 注意：企业微信智能助手的 markdown 支持有限，只支持基本语法：
 * - 标题：# ## ###
 * - 加粗：**text**
 * - 链接：[text](url)
 * - 列表：- 或 1.
 * - 引用：不引用（企业微信 markdown 可能不支持）
 */
export function buildMarkdownContent(opts: {
  text: string;
  thinking?: string | null;
  stats?: string | null;
}): string {
  const lines: string[] = [];

  // 思考内容（使用简单格式）
  if (opts.thinking) {
    lines.push('**💭 思考过程**');
    lines.push('');
    // 将思考内容每行加上缩进（企业微信 markdown 可能不支持引用）
    const thinkingLines = opts.thinking.split('\n');
    for (const line of thinkingLines) {
      lines.push(`　　${line}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // 主内容
  lines.push(opts.text);

  // 统计信息
  if (opts.stats) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`*${opts.stats}*`);
  }

  return lines.join('\n');
}
