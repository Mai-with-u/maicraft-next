/**
 * 统一的记忆管理器
 */

import { getLogger } from '@/utils/Logger';
import type { Logger } from '@/utils/Logger';
import { ThoughtMemory } from './ThoughtMemory';
import { ConversationMemory } from './ConversationMemory';
import { DecisionMemory } from './DecisionMemory';
import { ExperienceMemory } from './ExperienceMemory';
import type { MemoryStore, ThoughtEntry, ConversationEntry, DecisionEntry, ExperienceEntry, MemoryStats } from './types';
import type { MaiBotClient } from '../communication/MaiBotClient';

export class MemoryManager {
  private thoughts: ThoughtMemory;
  private conversations: ConversationMemory;
  private decisions: DecisionMemory;
  private experiences: ExperienceMemory;

  // 可扩展：添加新的记忆类型
  private customMemories: Map<string, MemoryStore<any>> = new Map();

  private logger: Logger;
  private webSocketServer?: any; // WebSocket服务器引用
  private botConfig?: any; // 机器人配置
  private maiBotClient?: MaiBotClient; // MaiBot 客户端

  constructor() {
    this.logger = getLogger('MemoryManager');
    this.thoughts = new ThoughtMemory();
    this.conversations = new ConversationMemory();
    this.decisions = new DecisionMemory();
    this.experiences = new ExperienceMemory();
  }

  /**
   * 初始化所有记忆存储
   */
  async initialize(): Promise<void> {
    this.logger.info('🧠 初始化记忆系统...');

    await Promise.all([this.thoughts.initialize(), this.conversations.initialize(), this.decisions.initialize(), this.experiences.initialize()]);

    this.logger.info('✅ 记忆系统初始化完成');
  }

  /**
   * 设置WebSocket服务器引用，用于推送记忆更新
   */
  setWebSocketServer(server: any): void {
    this.webSocketServer = server;
    const hasMemoryDataProvider = !!server?.memoryDataProvider;
    this.logger.info('📡 WebSocket服务器已连接到记忆管理器', {
      serverExists: !!server,
      hasMemoryDataProvider,
    });
  }

  /**
   * 设置机器人配置，用于格式化对话
   */
  setBotConfig(config: any): void {
    this.botConfig = config;
  }

  /**
   * 设置 MaiBot 客户端（由依赖注入系统调用）
   */
  setMaiBotClient(client: MaiBotClient): void {
    this.maiBotClient = client;

    // 设置回复回调：将 MaiBot 的回复添加到思考记忆中
    client.setOnReplyCallback((reply: string) => {
      this.recordThought(`[MaiBot回复] ${reply}`, {
        source: 'maibot',
        type: 'reply',
      });
    });

    this.logger.info('🤖 MaiBot 客户端已连接到记忆管理器');
  }

  /**
   * 获取 MaiBot 客户端
   */
  getMaiBotClient(): MaiBotClient | undefined {
    return this.maiBotClient;
  }

  /**
   * 注册自定义记忆类型
   */
  registerMemoryStore<T>(name: string, store: MemoryStore<T>): void {
    this.customMemories.set(name, store);
    this.logger.info(`📝 注册自定义记忆类型: ${name}`);
  }

  /**
   * 获取记忆存储
   */
  getMemoryStore<T>(name: string): MemoryStore<T> | undefined {
    return this.customMemories.get(name);
  }

  /**
   * 记录思考
   */
  recordThought(content: string, context?: Record<string, any>): void {
    const entry: ThoughtEntry = {
      id: this.generateId(),
      content,
      context,
      timestamp: Date.now(),
    };
    this.thoughts.add(entry);

    // 推送记忆更新到 WebSocket
    if (this.webSocketServer) {
      if (this.webSocketServer.memoryDataProvider) {
        this.webSocketServer.memoryDataProvider.pushMemory('thought', entry);
      } else {
        this.logger.warn('❌ memoryDataProvider 未初始化，无法推送思考记忆');
      }
    } else {
      this.logger.warn('❌ WebSocket服务器未设置，无法推送思考记忆');
    }

    // 发送给 MaiBot（如果不是来自 MaiBot 的回复）
    if (this.maiBotClient && context?.source !== 'maibot') {
      this.maiBotClient.sendThoughtMemory(entry);
    }
  }

  private stringifyForLog(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private truncateForLog(value: unknown, maxLength: number = 50): string {
    const text = this.stringifyForLog(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  /**
   * 记录对话
   */
  recordConversation(speaker: string, message: string, context?: Record<string, any>): void {
    const safeMessage = this.stringifyForLog(message);
    const entry = {
      id: this.generateId(),
      speaker,
      message: safeMessage,
      context,
      timestamp: Date.now(),
    };
    this.conversations.add(entry);
    this.logger.debug(`💬 记录对话: ${speaker} - ${this.truncateForLog(safeMessage, 50)}`);

    // 推送记忆更新
    if (this.webSocketServer?.memoryDataProvider) {
      this.webSocketServer.memoryDataProvider.pushMemory('conversation', entry);
    }
  }

  /**
   * 记录决策
   */
  recordDecision(intention: string, action: any, result: 'success' | 'failed' | 'interrupted', feedback?: string): void {
    const entry: DecisionEntry = {
      id: this.generateId(),
      intention,
      action,
      result,
      feedback,
      timestamp: Date.now(),
    };
    this.decisions.add(entry);
    this.logger.debug(`🎯 记录决策: ${result} - ${intention}`);

    // 推送记忆更新到 WebSocket
    if (this.webSocketServer?.memoryDataProvider) {
      this.webSocketServer.memoryDataProvider.pushMemory('decision', entry);
    }

    // 发送给 MaiBot
    if (this.maiBotClient) {
      this.maiBotClient.sendDecisionMemory(entry);
    }
  }

  /**
   * 记录经验
   */
  recordExperience(lesson: string, context: string, confidence: number = 0.5): void {
    const safeLesson = this.stringifyForLog(lesson);
    const safeContext = this.stringifyForLog(context);
    const entry = {
      id: this.generateId(),
      lesson: safeLesson,
      context: safeContext,
      confidence,
      occurrences: 1,
      timestamp: Date.now(),
      lastOccurrence: Date.now(),
    };
    this.experiences.add(entry);
    this.logger.debug(`📚 记录经验: ${this.truncateForLog(safeLesson, 50)} (置信度: ${(confidence * 100).toFixed(0)}%)`);

    // 推送记忆更新
    if (this.webSocketServer?.memoryDataProvider) {
      this.webSocketServer.memoryDataProvider.pushMemory('experience', entry);
    }
  }

  /**
   * 构建上下文摘要（整合所有记忆）
   */
  buildContextSummary(options: {
    includeThoughts?: number;
    includeConversations?: number;
    includeDecisions?: number;
    includeExperiences?: number;
    includeCustom?: Record<string, number>;
  }): string {
    const parts: string[] = [];

    // 思考记忆
    if (options.includeThoughts) {
      const thoughts = this.thoughts.getRecent(options.includeThoughts);
      if (thoughts.length > 0) {
        parts.push('【最近思考】');
        parts.push(thoughts.map(t => this.formatThought(t)).join('\n'));
      }
    }

    // 对话记忆
    if (options.includeConversations) {
      const conversations = this.conversations.getRecent(options.includeConversations);
      if (conversations.length > 0) {
        parts.push('\n【最近对话】');
        parts.push(conversations.map(c => this.formatConversation(c)).join('\n'));
      }
    }

    // 决策记忆
    if (options.includeDecisions) {
      const decisions = this.decisions.getRecent(options.includeDecisions);
      if (decisions.length > 0) {
        parts.push('\n【最近决策】');
        parts.push(decisions.map(d => this.formatDecision(d)).join('\n'));
      }
    }

    // 经验记忆
    if (options.includeExperiences) {
      const experiences = this.experiences.getRecent(options.includeExperiences);
      if (experiences.length > 0) {
        parts.push('\n【相关经验】');
        parts.push(experiences.map(e => this.formatExperience(e)).join('\n'));
      }
    }

    // 自定义记忆
    if (options.includeCustom) {
      for (const [name, count] of Object.entries(options.includeCustom)) {
        const store = this.customMemories.get(name);
        if (store) {
          const entries = store.getRecent(count);
          if (entries.length > 0) {
            parts.push(`\n【${name}】`);
            parts.push(entries.map(e => JSON.stringify(e)).join('\n'));
          }
        }
      }
    }

    return parts.join('\n');
  }

  /**
   * 保存所有记忆
   */
  async saveAll(): Promise<void> {
    this.logger.info('💾 保存记忆...');

    await Promise.all([
      this.thoughts.save(),
      this.conversations.save(),
      this.decisions.save(),
      this.experiences.save(),
      ...Array.from(this.customMemories.values()).map(store => store.save()),
    ]);

    this.logger.info('✅ 记忆保存完成');
  }

  /**
   * 加载所有记忆
   */
  async loadAll(): Promise<void> {
    this.logger.info('📖 加载记忆...');

    await Promise.all([
      this.thoughts.load(),
      this.conversations.load(),
      this.decisions.load(),
      this.experiences.load(),
      ...Array.from(this.customMemories.values()).map(store => store.load()),
    ]);

    this.logger.info('✅ 记忆加载完成');
  }

  /**
   * 获取所有记忆统计
   */
  getAllStats(): Record<string, MemoryStats> {
    return {
      thoughts: this.thoughts.getStats(),
      conversations: this.conversations.getStats(),
      decisions: this.decisions.getStats(),
      experiences: this.experiences.getStats(),
      ...Object.fromEntries(Array.from(this.customMemories.entries()).map(([name, store]) => [name, store.getStats()])),
    };
  }

  // 快捷访问方法
  get thought(): ThoughtMemory {
    return this.thoughts;
  }
  get conversation(): ConversationMemory {
    return this.conversations;
  }
  get decision(): DecisionMemory {
    return this.decisions;
  }
  get experience(): ExperienceMemory {
    return this.experiences;
  }

  /**
   * 更新记忆
   */
  updateMemory(memoryType: 'thought' | 'conversation' | 'decision' | 'experience', id: string, updates: any): boolean {
    switch (memoryType) {
      case 'thought':
        return this.thoughts.update(id, updates);
      case 'conversation':
        return this.conversations.update(id, updates);
      case 'decision':
        return this.decisions.update(id, updates);
      case 'experience':
        return this.experiences.update(id, updates);
      default:
        this.logger.warn(`未知的记忆类型: ${memoryType}`);
        return false;
    }
  }

  /**
   * 删除记忆
   */
  deleteMemory(memoryType: 'thought' | 'conversation' | 'decision' | 'experience', id: string): boolean {
    switch (memoryType) {
      case 'thought':
        return this.thoughts.delete(id);
      case 'conversation':
        return this.conversations.delete(id);
      case 'decision':
        return this.decisions.delete(id);
      case 'experience':
        return this.experiences.delete(id);
      default:
        this.logger.warn(`未知的记忆类型: ${memoryType}`);
        return false;
    }
  }

  /**
   * 根据ID查找记忆
   */
  findMemory(memoryType: 'thought' | 'conversation' | 'decision' | 'experience', id: string): any {
    switch (memoryType) {
      case 'thought':
        return this.thoughts.findById(id);
      case 'conversation':
        return this.conversations.findById(id);
      case 'decision':
        return this.decisions.findById(id);
      case 'experience':
        return this.experiences.findById(id);
      default:
        this.logger.warn(`未知的记忆类型: ${memoryType}`);
        return undefined;
    }
  }

  // 格式化方法
  private formatThought(t: ThoughtEntry): string {
    return `${this.formatTime(t.timestamp)}: ${t.content}`;
  }

  private formatConversation(c: ConversationEntry): string {
    // 如果是AI的消息，显示为 [我]，否则显示具体的用户名
    const botName = this.botConfig?.minecraft?.username || this.botConfig?.playerName || '麦麦';
    const speaker = c.speaker === botName ? '[我]' : c.speaker;
    return `${this.formatTime(c.timestamp)} ${speaker}: ${c.message}`;
  }

  private formatDecision(d: DecisionEntry): string {
    const icon = d.result === 'success' ? '✅' : d.result === 'failed' ? '❌' : '⚠️';

    // 提取动作信息
    let actionInfo = '';
    if (d.action) {
      const actionType = (d.action as any).actionType;
      const params = (d.action as any).params;

      if (actionType) {
        actionInfo = `[${actionType}${this.formatActionParams(actionType, params)}]`;
      }
    }

    // 格式：时间 图标 [动作名(参数)] 意图(反馈)
    const feedback = d.feedback ? `(${d.feedback})` : '';
    return `${this.formatTime(d.timestamp)} ${icon} ${actionInfo} ${d.intention}${feedback}`;
  }

  /**
   * 格式化动作参数，保持简洁可读
   */
  private formatActionParams(actionType: string, params: any): string {
    if (!params || typeof params !== 'object') return '';

    const hasNum = (value: any): value is number => typeof value === 'number' && Number.isFinite(value);
    const hasText = (value: any): value is string => typeof value === 'string' && value.trim().length > 0;

    switch (actionType) {
      case 'move':
        return hasNum(params.x) && hasNum(params.y) && hasNum(params.z)
          ? `(${params.x.toFixed(0)},${params.y.toFixed(0)},${params.z.toFixed(0)})`
          : '';

      case 'find_block':
        return hasText(params.block) ? `(${params.block})` : '';

      case 'mine_at_position':
      case 'mine_block':
        return hasNum(params.x) && hasNum(params.y) && hasNum(params.z)
          ? `(${params.x.toFixed(0)},${params.y.toFixed(0)},${params.z.toFixed(0)})`
          : '';

      case 'mine_by_type':
        return hasText(params.blockType) ? `(${params.blockType})` : '';

      case 'mine_in_direction':
        return hasText(params.direction) ? `(${params.direction})` : '';

      case 'place_block':
        return hasText(params.block) && hasNum(params.x) && hasNum(params.y) && hasNum(params.z)
          ? `(${params.block}→${params.x.toFixed(0)},${params.y.toFixed(0)},${params.z.toFixed(0)})`
          : '';

      case 'craft':
        return hasText(params.item) && hasNum(params.count)
          ? `(${params.item}×${params.count})`
          : hasText(params.item)
            ? `(${params.item})`
            : '';

      case 'use_chest':
      case 'use_furnace':
        return params.position && hasNum(params.position.x) && hasNum(params.position.y) && hasNum(params.position.z)
          ? `(x${params.position.x},y${params.position.y},z${params.position.z})`
          : '';

      case 'eat':
        return hasText(params.item) ? `(${params.item})` : '';

      case 'toss_item':
        return hasText(params.item) && hasNum(params.count)
          ? `(${params.item}×${params.count})`
          : hasText(params.item)
            ? `(${params.item})`
            : '';

      case 'kill_mob':
        return hasText(params.entity) ? `(${params.entity})` : '';

      case 'set_location':
        return hasText(params.name) && hasText(params.type) ? `(${params.type}:${params.name})` : '';

      case 'chat': {
        let text = '';

        if (typeof params.message === 'string') {
          text = params.message;
        } else if (params.message != null) {
          try {
            text = JSON.stringify(params.message);
          } catch {
            text = String(params.message);
          }
        }

        return text ? `("${text.slice(0, 20)}${text.length > 20 ? '...' : ''}")` : '';
      }

      case 'swim_to_land':
        return '';

      default:
        return '';
    }
  }

  private formatExperience(e: ExperienceEntry): string {
    return `${e.lesson} (置信度: ${(e.confidence * 100).toFixed(0)}%, 发生次数: ${e.occurrences})`;
  }

  private formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
