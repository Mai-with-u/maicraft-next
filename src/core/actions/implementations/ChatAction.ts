/**
 * ChatAction - 发送聊天消息
 *
 * 最简单但很重要的动作，用于与玩家交流
 */

import { BaseAction } from '@/core/actions/Action';
import { RuntimeContext } from '@/core/context/RuntimeContext';
import { ActionResult, ChatParams } from '@/core/actions/types';
import { ActionIds } from '@/core/actions/ActionIds';

export class ChatAction extends BaseAction<ChatParams> {
  readonly id = ActionIds.CHAT;
  readonly name = 'ChatAction';
  readonly description = '发送聊天消息到游戏中';

  async execute(context: RuntimeContext, params: ChatParams): Promise<ActionResult> {
    const rawMessage = params?.message;

    try {
      const message =
        typeof rawMessage === 'string'
          ? rawMessage
          : rawMessage == null
            ? ''
            : (() => {
                try {
                  return JSON.stringify(rawMessage);
                } catch {
                  return String(rawMessage);
                }
              })();

      // 验证消息
      if (!message || message.trim().length === 0) {
        return this.failure('消息不能为空');
      }

      // 检查消息长度（Minecraft 限制为 256 字符）
      if (message.length > 256) {
        return this.failure(`消息过长 (${message.length} > 256)`);
      }

      context.logger.info(`发送聊天消息: ${message}`);

      // 发送消息
      context.bot.chat(message);

      return this.success(`已发送消息: ${message}`);
    } catch (error) {
      const err = error as Error;
      context.logger.error('发送消息失败:', err);
      return this.failure(`发送消息失败: ${err.message}`, err);
    }
  }

  /**
   * 获取参数 Schema
   */
  getParamsSchema(): any {
    return {
      message: {
        type: 'string',
        description: '要发送的聊天消息',
        maxLength: 256,
      },
    };
  }
}
