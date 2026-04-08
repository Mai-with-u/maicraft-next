/**
 * 聊天响应模板
 */

import { PromptTemplate, promptManager } from '@/core/agent/prompt/prompt_manager';

export function initChatResponseTemplate(): void {
  promptManager.registerTemplate(
    new PromptTemplate(
      'chat_response',
      `# 最新消息
{sender_name} 说：{latest_message}{mentioned_bot}

# 最近对话记录
{recent_conversations}

# 当前状态
正在做：{current_activity}
位置：{position}

请回复 {sender_name} 的消息。`,
      '聊天响应',
      ['sender_name', 'latest_message', 'mentioned_bot', 'recent_conversations', 'current_activity', 'position'],
    ),
  );
}
