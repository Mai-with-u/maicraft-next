/**
 * 聊天循环
 */

import type { AgentState } from '@/core/agent/types';
import type { ConversationEntry } from '@/core/agent/memory/types';
import type { LLMClientResponse } from '@/llm/LLMManager';
import { promptManager } from '@/core/agent/prompt';
import { ActionIds } from '@/core/actions/ActionIds';
import { BaseLoop } from './BaseLoop';

export class ChatLoop extends BaseLoop<AgentState> {
  private llmManager: any; // LLMManager type

  private activeValue: number = 5;
  private selfTriggered: boolean = false;

  constructor(state: AgentState, llmManager: any) {
    super(state, 'ChatLoop');

    // 必须传入 llmManager，不允许创建新实例
    this.llmManager = llmManager;

    // 监听聊天事件
    this.setupChatListener();
    this.logger.info('💬 聊天循环初始化完成，等待聊天事件...');
  }

  /**
   * 设置聊天监听器
   */
  private setupChatListener(): void {
    this.state.context.events.on('chat', (data: any) => {
      // 获取机器人用户名，用于过滤自己的消息
      const botUsername = this.state.config.minecraft.username || this.state.context.gameState.playerName;

      // 检查是否是自己的消息 - 防止回复自己的话
      if (botUsername && data.username === botUsername) {
        // 是自己的消息，不记录也不响应
        this.logger.debug(`🤖 过滤自己的消息: ${data.message}`);
        return;
      }

      // 记录到记忆系统
      this.state.memory.recordConversation(data.username, data.message, {
        username: data.username,
      });
      this.logger.debug(`📝 记录对话: ${data.username}: ${data.message}`);

      // 检查是否被呼叫
      const botName = botUsername || 'bot';
      if (data.message.includes(botName)) {
        this.activeValue += 3;
        this.logger.debug(`📢 被呼叫: ${data.message}`);
      }
    });
  }

  /**
   * 执行一次循环迭代
   */
  protected async runLoopIteration(): Promise<void> {
    await this.sleep(500);

    // 获取最近的对话
    const recentConversations = this.state.memory.conversation.getRecent(1);

    if (recentConversations.length === 0) {
      return;
    }

    const lastConversation = recentConversations[0];

    // 检查是否应该响应
    if (this.shouldRespond(lastConversation)) {
      await this.respondToChat(lastConversation);
      this.activeValue -= 1;
    } else if (Math.random() < 0.02 && !this.selfTriggered) {
      // 随机自发聊天
      await this.initiateChat();
      // 修复：设置冷却时间戳，而不是永久禁止自发聊天
      this.selfTriggered = true;
      setTimeout(() => {
        this.selfTriggered = false;
      }, 5 * 60 * 1000); // 5分钟冷却
    }
  }

  /**
   * 是否应该响应
   */
  private shouldRespond(conversation: ConversationEntry): boolean {
    // 不响应自己的消息（AI的消息）
    const botName = this.state.config.minecraft.username || this.state.context.gameState.playerName || '麦麦';
    if (conversation.speaker === botName) {
      return false;
    }

    // 被呼叫时，一定响应
    if (conversation.message.includes(botName)) {
      this.logger.debug(`🎯 响应呼叫: ${conversation.message}`);
      return true;
    }

    // 根据活跃度和随机概率决定是否响应
    const shouldRespond = this.activeValue > 0 && Math.random() < 0.3;
    if (shouldRespond) {
      this.logger.debug(`💬 主动响应: ${conversation.message}`);
    }

    return shouldRespond;
  }

  /**
   * 响应聊天
   */
  private async respondToChat(lastConversation: ConversationEntry): Promise<void> {
    try {
      const botName = this.state.config.minecraft.username || this.state.context.gameState.playerName || '麦麦';
      const senderName = lastConversation.speaker;
      const mentionedBot = lastConversation.message.includes(botName);

      const recentConversations = this.state.memory.conversation.getRecent(10);
      const conversationText = recentConversations
        .map(c => {
          const speakerDisplay = c.speaker === botName ? '[我]' : `[${c.speaker}]`;
          return `${speakerDisplay}: ${c.message}`;
        })
        .join('\n');

      const userPrompt = promptManager.generatePrompt('chat_response', {
        sender_name: senderName,
        latest_message: lastConversation.message,
        mentioned_bot: mentionedBot ? `（@了我）` : '',
        recent_conversations: conversationText,
        current_activity: this.state.planningManager.getCurrentTask()?.title || '空闲中',
        position: `(${this.state.context.gameState.blockPosition.x}, ${this.state.context.gameState.blockPosition.y}, ${this.state.context.gameState.blockPosition.z})`,
      });

      const systemPrompt = promptManager.generatePrompt('chat_response_system', {
        bot_name: botName,
        sender_name: senderName,
      });
      const response = await this.llmManager.chatCompletion(userPrompt, systemPrompt);

      const message = this.parseChatResponse(response);

      if (message) {
        await this.state.context.executor.execute(ActionIds.CHAT, { message });
        this.state.memory.recordConversation(botName, message);
        this.logger.info(`💬 发送聊天: ${message}`);
      }
    } catch (error) {
      this.logger.error('❌ 响应聊天失败', undefined, error as Error);
    }
  }

  /**
   * 主动发起聊天
   */
  private async initiateChat(): Promise<void> {
    try {
      const botName = this.state.config.minecraft.username || this.state.context.gameState.playerName || '麦麦';

      const recentConversations = this.state.memory.conversation.getRecent(5);
      const conversationText = recentConversations
        .map(c => {
          const speakerDisplay = c.speaker === botName ? '[我]' : `[${c.speaker}]`;
          return `${speakerDisplay}: ${c.message}`;
        })
        .join('\n');

      const userPrompt = promptManager.generatePrompt('chat_initiate', {
        recent_conversations: conversationText,
        current_activity: this.state.planningManager.getCurrentTask()?.title || '空闲中',
        position: `(${this.state.context.gameState.blockPosition.x}, ${this.state.context.gameState.blockPosition.y}, ${this.state.context.gameState.blockPosition.z})`,
      });

      const systemPrompt = promptManager.generatePrompt('chat_initiate_system', {
        bot_name: botName,
      });
      const response = await this.llmManager.chatCompletion(userPrompt, systemPrompt);

      const message = this.parseChatResponse(response);

      if (message) {
        await this.state.context.executor.execute(ActionIds.CHAT, { message });
        this.state.memory.recordConversation(this.state.context.gameState.playerName || '麦麦', message);
        this.logger.info(`💬 主动聊天: ${message}`);
      }
    } catch (error) {
      this.logger.error('❌ 主动聊天失败:', undefined, error as Error);
    }
  }

  /**
   * 解析聊天响应
   * 系统提示词已要求"直接输出纯文本"，不用 JSON / 标签解析
   */
  private parseChatResponse(response: LLMClientResponse): string | null {
    if (!response.success) {
      this.logger.error('LLM聊天调用失败', { error: response.error });
      return null;
    }

    const content = (response.content || '').trim();
    if (!content) return null;

    // 系统 prompt 要求纯文本输出，直接返回内容
    // 兜底：如果模型仍然输出了 JSON，尝试提取 message 字段
    if (content.startsWith('{')) {
      try {
        const json = JSON.parse(content);
        return (json.message || json.reply || json.content || '').trim() || null;
      } catch {
        // 不是有效 JSON，按原文返回
      }
    }

    return content;
  }
}
