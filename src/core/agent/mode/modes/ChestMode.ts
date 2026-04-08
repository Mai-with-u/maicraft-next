/**
 * 箱子GUI模式
 *
 * 参考原maicraft的ChestGUIMode设计
 * 负责箱子物品存取任务的GUI操作
 * 需要LLM决策的主动模式
 */

import { BaseMode } from '@/core/agent/mode/BaseMode';
import { ModeManager } from '@/core/agent/mode/ModeManager';
import type { RuntimeContext } from '@/core/context/RuntimeContext';
import type { AgentState } from '@/core/agent/types';
import type { BlockPosition } from '@/core/cache/NearbyBlockManager';
import { ActionIds } from '@/core/actions/ActionIds';
import { getLogger } from '@/utils/Logger';
import { promptManager } from '@/core/agent/prompt';
import { StructuredOutputManager } from '@/core/agent/structured/StructuredOutputManager';

interface ChestSlot {
  [itemName: string]: number;
}

interface ChestAction {
  action_type: 'take_items' | 'put_items';
  item: string;
  count: number | 'all';
}

export class ChestMode extends BaseMode {
  readonly type = ModeManager.MODE_TYPES.CHEST_GUI;
  readonly name = '箱子模式';
  readonly description = '执行箱子物品存取任务的GUI操作';
  readonly priority = 50; // 中等优先级
  readonly requiresLLMDecision = true; // 需要LLM决策

  // 模式配置 - 参考原maicraft设计
  readonly maxDuration = 300; // 5分钟
  readonly autoRestore = true; // 自动恢复到主模式
  readonly restoreDelay = 5; // 5秒后恢复

  // GameStateListener 实现
  readonly listenerName = 'ChestMode';
  readonly enabled = false; // GUI模式不需要监听游戏状态

  // 箱子特定状态
  private position: BlockPosition | null = null;
  private chestInventory: ChestSlot = {};
  private initialChestInventory: ChestSlot = {}; // 初始快照
  private tempChestInventory: ChestSlot = {}; // 临时快照
  private structuredOutputManager: StructuredOutputManager | null = null;

  constructor(context: RuntimeContext) {
    super(context);
    // 重新设置logger以使用正确的名称
    this.logger = getLogger(this.name);
  }

  /**
   * 绑定Agent状态并初始化结构化输出管理器
   */
  bindState(state: AgentState): void {
    super.bindState(state);
    if (state?.llmManager) {
      // TODO: 临时禁用结构化输出，使用降级解析方案
      this.structuredOutputManager = new StructuredOutputManager(state.llmManager, {
        useStructuredOutput: false, // 暂时使用手动解析
      });
    }
  }

  /**
   * 设置箱子位置
   */
  setPosition(position: BlockPosition): void {
    this.position = position;
    this.logger.info(`📦 设置箱子位置: (${position.x}, ${position.y}, ${position.z})`);
  }

  /**
   * 激活模式
   */
  protected async onActivate(reason: string): Promise<void> {
    this.logger.info(`📦 激活箱子模式: ${reason}`);

    if (!this.position) {
      this.logger.error('❌ 箱子位置未设置，无法激活模式');
      return;
    }

    // 记录到思考日志
    if (this.state?.memory) {
      this.state.memory.recordThought(`📦 开始箱子操作: ${reason}`);
    }

    // ⚠️ 不在 onActivate 中查询箱子！
    // onActivate 期间主循环仍在运行，可能导致并发问题和事件循环阻塞
    // 所有查询操作都在 execute() 中进行
    this.logger.info(`📦 箱子模式已激活，将在 execute() 中查询箱子状态`);
  }

  /**
   * 停用模式
   */
  protected async onDeactivate(reason: string): Promise<void> {
    this.logger.info(`📦 停用箱子模式: ${reason}`);

    // 生成操作总结
    const summary = this.summarizeChestDiff();
    if (summary && this.state?.memory) {
      this.state.memory.recordThought(`📦 箱子操作总结: ${summary}`);
    }

    // 记录到思考日志
    if (this.state?.memory) {
      this.state.memory.recordThought(`📦 箱子操作完成: ${reason}`);
    }

    // 清理状态
    this.clearChestState();
  }

  /**
   * 模式主逻辑 - LLM决策
   */
  async execute(): Promise<void> {
    this.logger.info('📦 [ChestMode] execute() 开始执行');

    if (!this.state || !this.position) {
      this.logger.warn('⚠️ 箱子模式缺少必要组件，无法执行');
      return;
    }

    try {
      // 🔧 关键修复：等待一段时间，让主循环的其他任务（生成目标、扫描方块等）完成
      // 避免在查询箱子时事件循环被阻塞
      this.logger.info('📦 [ChestMode] 等待事件循环清空...');
      await new Promise(resolve => setTimeout(resolve, 500));

      // 只有当初始化失败（箱子状态为空）时才重新查询
      const needQuery = Object.keys(this.chestInventory).length === 0 && Object.keys(this.initialChestInventory).length === 0;

      if (needQuery) {
        this.logger.info('📦 [ChestMode] 检测到箱子状态未初始化，开始查询...');
        await this.updateChestState();
        this.logger.info('📦 [ChestMode] 箱子状态查询完成');
      } else {
        this.logger.info('📦 [ChestMode] 箱子状态已初始化，跳过查询');
      }

      // 执行LLM决策
      this.logger.info('📦 [ChestMode] 开始执行LLM决策...');
      await this.executeLLMDecision();
      this.logger.info('📦 [ChestMode] LLM决策执行完成');
    } catch (error) {
      this.logger.error('❌ 箱子模式执行异常:', undefined, error as Error);

      if (this.state?.memory) {
        this.state.memory.recordThought(`❌ 箱子操作异常: ${error}`);
      }
    }

    this.logger.info('📦 [ChestMode] execute() 执行结束');
  }

  /**
   * 检查自动转换
   */
  async checkTransitions(): Promise<string[]> {
    const targetModes: string[] = [];

    // 检查是否超时
    if (this.isExpired()) {
      targetModes.push(ModeManager.MODE_TYPES.MAIN);
    }

    return targetModes;
  }

  /**
   * 初始化箱子状态
   */
  private async initializeChestState(): Promise<void> {
    if (!this.position || !this.state) return;

    try {
      // 查询箱子容器信息
      const result = await this.state.context.executor.execute(ActionIds.QUERY_CONTAINER, {
        position: this.position,
      });

      if (result.success && result.data) {
        this.chestInventory = result.data.inventory || {};
        this.initialChestInventory = { ...this.chestInventory };
        this.tempChestInventory = { ...this.chestInventory };

        this.logger.info('✅ 箱子状态初始化完成');
      } else {
        // 初始化失败时，使用空状态，稍后在execute时会重试
        this.logger.warn('⚠️ 箱子状态初始化失败，将在执行时重试');
        this.chestInventory = {};
        this.initialChestInventory = {};
        this.tempChestInventory = {};

        // 清理可能打开的窗口，避免状态不一致
        this.cleanupWindow();
      }
    } catch (error) {
      this.logger.warn('⚠️ 箱子状态初始化异常，将在执行时重试', { error: error as Error });
      // 初始化失败不应该阻止模式激活，稍后会重试
      this.chestInventory = {};
      this.initialChestInventory = {};
      this.tempChestInventory = {};

      // 清理可能打开的窗口，避免状态不一致
      this.cleanupWindow();
    }
  }

  /**
   * 更新箱子状态
   */
  private async updateChestState(): Promise<void> {
    if (!this.position || !this.state) return;

    try {
      const result = await this.state.context.executor.execute(ActionIds.QUERY_CONTAINER, {
        position: this.position,
      });

      if (result.success && result.data) {
        this.tempChestInventory = this.chestInventory;
        this.chestInventory = result.data.inventory || {};
        this.logger.info('✅ 箱子状态更新成功');
      } else {
        this.logger.warn('⚠️ 箱子状态更新失败，使用缓存状态');
      }
    } catch (error) {
      this.logger.warn('⚠️ 箱子状态更新异常，使用缓存状态', { error: error as Error });
    }
  }

  /**
   * 执行LLM决策（使用结构化输出）
   */
  private async executeLLMDecision(): Promise<void> {
    this.logger.info('📦 [ChestMode] executeLLMDecision() 开始');

    if (!this.state || !this.structuredOutputManager) {
      this.logger.error('❌ 状态或结构化输出管理器未初始化');
      return;
    }

    // 生成箱子状态描述
    const chestDescription = this.generateChestDescription();
    this.logger.info(`📦 [ChestMode] 箱子状态描述: ${chestDescription}`);

    // 收集上下文信息（参考原maicraft的设计）
    const contextInfo = this.state.memory.buildContextSummary({
      includeThoughts: 5, // 最近5条思考记忆
      includeConversations: 3, // 最近3条对话
      includeDecisions: 3, // 最近3条决策
    });

    // 获取目标和任务
    const currentGoal = this.state.planningManager?.getCurrentGoal();
    const currentTask = this.state.planningManager?.getCurrentTask();

    // 生成提示词
    const prompt = promptManager.generatePrompt('chest_operation', {
      chest_gui: chestDescription,
      bot_name: this.state.config.minecraft.username || this.state.context.gameState.playerName || 'MaicraftBot',
      player_name: this.state.config.minecraft.username || this.state.context.gameState.playerName || 'MaicraftBot',
      context_info: contextInfo,
      current_goal: currentGoal ? `当前目标: ${currentGoal.description}` : '',
      current_tasks: currentTask ? `当前任务: ${currentTask.description}` : '',
    });

    // 生成系统提示词
    const systemPrompt = promptManager.generatePrompt('chest_operation_system', {
      bot_name: this.state.config.minecraft.username || this.state.context.gameState.playerName || 'MaicraftBot',
      player_name: this.state.config.minecraft.username || this.state.context.gameState.playerName || 'MaicraftBot',
    });

    this.logger.info('📦 [ChestMode] 提示词生成完成，准备请求LLM...');

    // 使用结构化输出请求箱子操作
    const structuredResponse = await this.structuredOutputManager.requestChestOperations(prompt, systemPrompt);

    if (!structuredResponse) {
      this.logger.warn('⚠️ [ChestMode] 箱子LLM结构化输出获取失败');
      // 🔧 不再自动退出，直接返回，让 MainMode 处理
      return;
    }

    this.logger.info(`📦 [ChestMode] 箱子LLM响应完成`);

    // 记录思考过程
    if (structuredResponse.thinking && this.state.memory) {
      this.state.memory.recordThought(`📦 箱子操作思考: ${structuredResponse.thinking}`);
    }

    // 执行结构化的箱子动作
    this.logger.info('📦 [ChestMode] 开始执行箱子动作...');
    await this.executeStructuredChestAction(structuredResponse.action);
    this.logger.info('📦 [ChestMode] 箱子动作执行完成');

    // 🔧 不再自动退出模式，由 MainMode.handleGUIAction 负责切换回主模式
    this.logger.info('📦 [ChestMode] 箱子操作完成');
  }

  /**
   * 生成箱子状态描述
   */
  private generateChestDescription(): string {
    if (Object.keys(this.chestInventory).length === 0) {
      return '**箱子内容**: 空';
    }

    const items = Object.entries(this.chestInventory)
      .map(([item, count]) => `${item} x${count}`)
      .join(', ');

    return `**箱子内容**: ${items}`;
  }

  /**
   * 执行结构化的箱子动作（智能判断单动作或批量操作）
   */
  private async executeStructuredChestAction(action: any): Promise<void> {
    if (!action) {
      this.logger.info('📦 箱子动作为空，无需执行任何操作');
      return;
    }

    this.logger.debug(`📦 箱子动作详情: ${JSON.stringify(action, null, 2)}`);

    // 检查是否有操作序列（批量操作）
    if (action.sequence && Array.isArray(action.sequence)) {
      await this.executeChestActionSequence(action.sequence);
    } else {
      // 单动作执行
      await this.executeSingleChestAction(action);
    }

    // 更新箱子状态
    await this.updateChestState();
  }

  /**
   * 执行箱子动作序列（批量操作）
   */
  private async executeChestActionSequence(actions: any[]): Promise<void> {
    if (!actions || actions.length === 0) {
      this.logger.info('📦 箱子动作序列为空，无需执行任何操作');
      return;
    }

    this.logger.info(`📦 准备批量执行 ${actions.length} 个箱子动作`);

    // 执行每个动作
    for (let i = 0; i < actions.length; i++) {
      const chestAction = actions[i];

      this.logger.debug(`📦 箱子动作 ${i + 1}/${actions.length} 详情: ${JSON.stringify(chestAction, null, 2)}`);

      // 验证动作格式
      if (!this.validateChestAction(chestAction)) {
        this.logger.warn(`⚠️ 箱子动作 ${i + 1}/${actions.length}: 格式无效，跳过`);
        continue;
      }

      this.logger.info(`📦 执行箱子动作 ${i + 1}/${actions.length}: ${chestAction.action_type} ${chestAction.item} x${chestAction.count}`);

      // 执行动作
      try {
        const result = await this.executeChestAction(chestAction as ChestAction);

        if (result.success) {
          this.logger.info(`✅ 箱子动作 ${i + 1}/${actions.length} 成功: ${result.message}`);
        } else {
          this.logger.warn(`⚠️ 箱子动作 ${i + 1}/${actions.length} 失败: ${result.message}`);
          // 批量操作中，单个动作失败不终止整个序列
        }

        // 动作间隔（除了最后一个动作）
        if (i < actions.length - 1) {
          await this.sleep(300);
        }
      } catch (executeError) {
        this.logger.error(`❌ 箱子动作 ${i + 1}/${actions.length} 执行异常:`, undefined, executeError as Error);
      }
    }
  }

  /**
   * 执行单个箱子动作
   */
  private async executeSingleChestAction(action: any): Promise<void> {
    // 验证动作格式
    if (!this.validateChestAction(action)) {
      this.logger.warn('⚠️ 箱子动作格式无效');
      return;
    }

    this.logger.info(`📦 执行箱子动作: ${action.action_type} ${action.item} x${action.count}`);

    // 执行动作
    try {
      const result = await this.executeChestAction(action as ChestAction);

      if (result.success) {
        this.logger.info(`✅ 箱子动作成功: ${result.message}`);
      } else {
        this.logger.warn(`⚠️ 箱子动作失败: ${result.message}`);
      }
    } catch (executeError) {
      this.logger.error('❌ 箱子动作执行异常:', undefined, executeError as Error);
    }
  }

  /**
   * 验证箱子动作格式
   */
  private validateChestAction(action: any): boolean {
    return (
      action &&
      typeof action.action_type === 'string' &&
      ['take_items', 'put_items'].includes(action.action_type) &&
      typeof action.item === 'string' &&
      (typeof action.count === 'number' || action.count === 'all')
    );
  }

  /**
   * 执行单个箱子动作
   */
  private async executeChestAction(action: ChestAction): Promise<{ success: boolean; message: string }> {
    if (!this.position || !this.state) {
      return { success: false, message: '箱子位置或状态未设置' };
    }

    try {
      const count = action.count === 'all' ? 999 : action.count;

      const result = await this.state.context.executor.execute(ActionIds.MANAGE_CONTAINER, {
        position: this.position,
        action: action.action_type,
        item: action.item,
        count: count,
      });

      // 记录到思考日志
      if (this.state.memory) {
        const actionText = action.action_type === 'take_items' ? '从箱子取出' : '放入箱子';
        this.state.memory.recordThought(`📦 箱子操作: ${actionText} ${action.item} x${action.count}`);
      }

      return result;
    } catch (error) {
      this.logger.error('❌ 箱子动作执行异常:', undefined, error as Error);
      return { success: false, message: `执行异常: ${error}` };
    }
  }

  /**
   * 总结箱子操作差异
   */
  private summarizeChestDiff(): string {
    const prev = this.tempChestInventory;
    const curr = this.chestInventory;

    // 计算差异：正数表示存入，负数表示取出
    const allItems = new Set([...Object.keys(prev), ...Object.keys(curr)]);
    const putList: string[] = [];
    const takeList: string[] = [];

    for (const itemName of allItems) {
      const before = prev[itemName] || 0;
      const after = curr[itemName] || 0;
      const delta = after - before;

      if (delta > 0) {
        putList.push(`${itemName} x${delta}`);
      } else if (delta < 0) {
        takeList.push(`${itemName} x${-delta}`);
      }
    }

    const parts: string[] = [];
    if (putList.length > 0) {
      parts.push(`存入: ${putList.join(', ')}`);
    }
    if (takeList.length > 0) {
      parts.push(`取出: ${takeList.join(', ')}`);
    }

    return parts.length > 0 ? parts.join(' | ') : '无变化';
  }

  /**
   * 清理箱子状态
   */
  private clearChestState(): void {
    this.chestInventory = {};
    this.initialChestInventory = {};
    this.tempChestInventory = {};
  }

  /**
   * 获取箱子统计信息
   */
  getChestStats(): {
    position: BlockPosition | null;
    itemCount: number;
    uniqueItems: number;
  } {
    return {
      position: this.position,
      itemCount: Object.values(this.chestInventory).reduce((sum, count) => sum + count, 0),
      uniqueItems: Object.keys(this.chestInventory).length,
    };
  }

  /**
   * 等待方法（用于动作间隔）
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 清理可能打开的窗口
   */
  private cleanupWindow(): void {
    if (!this.state?.context.bot.currentWindow) {
      return;
    }

    try {
      this.logger.warn('⚠️ 检测到未关闭的窗口，强制关闭');
      this.state.context.bot.closeWindow(this.state.context.bot.currentWindow);
    } catch (error) {
      this.logger.error('❌ 关闭窗口失败:', undefined, error as Error);
    }
  }
}
