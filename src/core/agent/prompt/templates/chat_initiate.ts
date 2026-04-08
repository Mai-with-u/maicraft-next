/**
 * 主动聊天模板
 */

import { PromptTemplate, promptManager } from '@/core/agent/prompt/prompt_manager';

export function initChatInitiateTemplate(): void {
  promptManager.registerTemplate(
    new PromptTemplate(
      'chat_initiate',
      `# 最近对话记录
{recent_conversations}

# 当前状态
正在做：{current_activity}
位置：{position}

你想主动说点什么。可以分享当前在做的事、遇到的有趣情况，或者随口问一句。`,
      '主动聊天',
      ['recent_conversations', 'current_activity', 'position'],
    ),
  );
}
