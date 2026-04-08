/**
 * 熔炉GUI模式
 *
 * 参考原maicraft的FurnaceGUIMode设计
 * 负责熔炉冶炼任务的GUI操作
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

interface FurnaceSlot {
  [itemName: string]: number;
}

interface FurnaceAction {
  action_type: 'take_items' | 'put_items';
  slot: 'input' | 'fuel' | 'output';
  item: string;
  count: number | 'all';
}

export class FurnaceMode extends BaseMode {
  readonly type = ModeManager.MODE_TYPES.FURNACE_GUI;
  readonly name = '熔炉模式';
  readonly description = '执行熔炉冶炼任务的GUI操作';
  readonly priority = 50; // 中等优先级
  readonly requiresLLMDecision = true; // 需要LLM决策

  // 模式配置 - 参考原maicraft设计
  readonly maxDuration = 300; // 5分钟
  readonly autoRestore = true; // 自动恢复到主模式
  readonly restoreDelay = 5; // 5秒后恢复

  // GameStateListener 实现
  readonly listenerName = 'FurnaceMode';
  readonly enabled = false; // GUI模式不需要监听游戏状态

  // 熔炉特定状态
  private position: BlockPosition | null = null;
  private inputSlot: FurnaceSlot = {};
  private fuelSlot: FurnaceSlot = {};
  private outputSlot: FurnaceSlot = {};
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
   * 设置熔炉位置
   */
  setPosition(position: BlockPosition): void {
    this.position = position;
    this.logger.info(`🔥 设置熔炉位置: (${position.x}, ${position.y}, ${position.z})`);
  }

  /**
   * 激活模式
   */
  protected async onActivate(reason: string): Promise<void> {
    this.logger.info(`🔥 激活熔炉模式: ${reason}`);

    if (!this.position) {
      this.logger.error('❌ 熔炉位置未设置，无法激活模式');
      return;
    }

    // 记录到思考日志
    if (this.state?.memory) {
      this.state.memory.recordThought(`🔥 开始熔炉操作: ${reason}`);
    }

    // 初始化熔炉状态
    await this.initializeFurnaceState();
  }

  /**
   * 停用模式
   */
  protected async onDeactivate(reason: string): Promise<void> {
    this.logger.info(`🟡 停用熔炉模式: ${reason}`);

    // 记录到思考日志
    if (this.state?.memory) {
      this.state.memory.recordThought(`🟡 熔炉操作完成: ${reason}`);
    }

    // 清理状态
    this.clearFurnaceState();
  }

  /**
   * 模式主逻辑 - LLM决策
   */
  async execute(): Promise<void> {
    if (!this.state || !this.position) {
      this.logger.warn('⚠️ 熔炉模式缺少必要组件，无法执行');
      return;
    }

    try {
      // 更新熔炉状态
      await this.updateFurnaceState();

      // 执行LLM决策
      await this.executeLLMDecision();
    } catch (error) {
      this.logger.error('❌ 熔炉模式执行异常:', undefined, error as Error);

      if (this.state?.memory) {
        this.state.memory.recordThought(`❌ 熔炉操作异常: ${error}`);
      }
    }
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
   * 初始化熔炉状态
   */
  private async initializeFurnaceState(): Promise<void> {
    if (!this.position || !this.state) return;

    try {
      // 查询熔炉容器信息
      const result = await this.state.context.executor.execute(ActionIds.QUERY_CONTAINER, {
        position: this.position,
      });

      if (result.success && result.data) {
        this.inputSlot = result.data.input || {};
        this.fuelSlot = result.data.fuel || {};
        this.outputSlot = result.data.output || {};

        this.logger.debug('🔥 熔炉状态初始化完成', {
          input: this.inputSlot,
          fuel: this.fuelSlot,
          output: this.outputSlot,
        });
      }
    } catch (error) {
      this.logger.error('❌ 熔炉状态初始化失败:', undefined, error as Error);
    }
  }

  /**
   * 更新熔炉状态
   */
  private async updateFurnaceState(): Promise<void> {
    if (!this.position || !this.state) return;

    try {
      const result = await this.state.context.executor.execute(ActionIds.QUERY_CONTAINER, {
        position: this.position,
      });

      if (result.success && result.data) {
        this.inputSlot = result.data.input || {};
        this.fuelSlot = result.data.fuel || {};
        this.outputSlot = result.data.output || {};
      }
    } catch (error) {
      this.logger.error('❌ 熔炉状态更新失败:', undefined, error as Error);
    }
  }

  /**
   * 执行LLM决策（使用结构化输出）
   */
  private async executeLLMDecision(): Promise<void> {
    if (!this.state || !this.structuredOutputManager) {
      this.logger.error('❌ 状态或结构化输出管理器未初始化');
      return;
    }

    // 生成熔炉状态描述
    const furnaceDescription = this.generateFurnaceDescription();

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
    const prompt = promptManager.generatePrompt('furnace_operation', {
      furnace_gui: furnaceDescription,
      bot_name: this.state.config.minecraft.username || this.state.context.gameState.playerName || 'MaicraftBot',
      player_name: this.state.config.minecraft.username || this.state.context.gameState.playerName || 'MaicraftBot',
      context_info: contextInfo,
      current_goal: currentGoal ? `当前目标: ${currentGoal.description}` : '',
      current_tasks: currentTask ? `当前任务: ${currentTask.description}` : '',
    });

    // 生成系统提示词
    const systemPrompt = promptManager.generatePrompt('furnace_operation_system', {
      bot_name: this.state.config.minecraft.username || this.state.context.gameState.playerName || 'MaicraftBot',
      player_name: this.state.config.minecraft.username || this.state.context.gameState.playerName || 'MaicraftBot',
    });

    this.logger.debug('🔥 生成熔炉操作提示词完成（包含上下文）');

    // 使用结构化输出请求熔炉操作
    const structuredResponse = await this.structuredOutputManager.requestFurnaceOperations(prompt, systemPrompt);

    if (!structuredResponse) {
      this.logger.warn('⚠️ 熔炉LLM结构化输出获取失败');
      return;
    }

    this.logger.info('🔥 熔炉LLM响应完成');

    // 记录思考过程
    if (structuredResponse.thinking && this.state.memory) {
      this.state.memory.recordThought(`🔥 熔炉操作思考: ${structuredResponse.thinking}`);
    }

    // 执行结构化的熔炉动作
    await this.executeStructuredFurnaceAction(structuredResponse.action);
  }

  /**
   * 生成熔炉状态描述
   */
  private generateFurnaceDescription(): string {
    const parts: string[] = [];

    // 输入槽
    if (Object.keys(this.inputSlot).length > 0) {
      const inputItems = Object.entries(this.inputSlot)
        .map(([item, count]) => `${item} x${count}`)
        .join(', ');
      parts.push(`**输入槽**: ${inputItems}`);
    } else {
      parts.push('**输入槽**: 空');
    }

    // 燃料槽
    if (Object.keys(this.fuelSlot).length > 0) {
      const fuelItems = Object.entries(this.fuelSlot)
        .map(([item, count]) => `${item} x${count}`)
        .join(', ');
      parts.push(`**燃料槽**: ${fuelItems}`);
    } else {
      parts.push('**燃料槽**: 空');
    }

    // 输出槽
    if (Object.keys(this.outputSlot).length > 0) {
      const outputItems = Object.entries(this.outputSlot)
        .map(([item, count]) => `${item} x${count}`)
        .join(', ');
      parts.push(`**输出槽**: ${outputItems}`);
    } else {
      parts.push('**输出槽**: 空');
    }

    return parts.join('\n');
  }

  /**
   * 执行结构化的熔炉动作（智能判断单动作或批量操作）
   */
  private async executeStructuredFurnaceAction(action: any): Promise<void> {
    if (!action) {
      this.logger.warn('⚠️ 熔炉动作为空');
      return;
    }

    this.logger.debug(`🔥 熔炉动作详情: ${JSON.stringify(action, null, 2)}`);

    // 检查是否有操作序列（批量操作）
    if (action.sequence && Array.isArray(action.sequence)) {
      await this.executeFurnaceActionSequence(action.sequence);
    } else {
      // 单动作执行
      await this.executeSingleFurnaceAction(action);
    }

    // 更新熔炉状态
    await this.updateFurnaceState();
  }

  /**
   * 执行熔炉动作序列（批量操作）
   */
  private async executeFurnaceActionSequence(actions: any[]): Promise<void> {
    if (!actions || actions.length === 0) {
      this.logger.warn('⚠️ 熔炉动作序列为空');
      return;
    }

    this.logger.info(`🔥 准备批量执行 ${actions.length} 个熔炉动作`);

    // 执行每个动作
    for (let i = 0; i < actions.length; i++) {
      const furnaceAction = actions[i];

      this.logger.debug(`🔥 熔炉动作 ${i + 1}/${actions.length} 详情: ${JSON.stringify(furnaceAction, null, 2)}`);

      // 验证动作格式
      if (!this.validateFurnaceAction(furnaceAction)) {
        this.logger.warn(`⚠️ 熔炉动作 ${i + 1}/${actions.length}: 格式无效，跳过`);
        continue;
      }

      this.logger.info(
        `🔥 执行熔炉动作 ${i + 1}/${actions.length}: ${furnaceAction.action_type} ${furnaceAction.item} x${furnaceAction.count} @ ${furnaceAction.slot}`,
      );

      // 执行动作
      try {
        const result = await this.executeFurnaceAction(furnaceAction as FurnaceAction);

        if (result.success) {
          this.logger.info(`✅ 熔炉动作 ${i + 1}/${actions.length} 成功: ${result.message}`);
        } else {
          this.logger.warn(`⚠️ 熔炉动作 ${i + 1}/${actions.length} 失败: ${result.message}`);
          // 批量操作中，单个动作失败不终止整个序列
        }

        // 动作间隔（除了最后一个动作）
        if (i < actions.length - 1) {
          await this.sleep(300);
        }
      } catch (executeError) {
        this.logger.error(`❌ 熔炉动作 ${i + 1}/${actions.length} 执行异常:`, undefined, executeError as Error);
      }
    }
  }

  /**
   * 执行单个熔炉动作
   */
  private async executeSingleFurnaceAction(action: any): Promise<void> {
    // 验证动作格式
    if (!this.validateFurnaceAction(action)) {
      this.logger.warn('⚠️ 熔炉动作格式无效');
      return;
    }

    this.logger.info(`🔥 执行熔炉动作: ${action.action_type} ${action.item} x${action.count} @ ${action.slot}`);

    // 执行动作
    try {
      const result = await this.executeFurnaceAction(action as FurnaceAction);

      if (result.success) {
        this.logger.info(`✅ 熔炉动作成功: ${result.message}`);
      } else {
        this.logger.warn(`⚠️ 熔炉动作失败: ${result.message}`);
      }
    } catch (executeError) {
      this.logger.error('❌ 熔炉动作执行异常:', undefined, executeError as Error);
    }
  }

  /**
   * 验证熔炉动作格式
   */
  private validateFurnaceAction(action: any): boolean {
    return (
      action &&
      typeof action.action_type === 'string' &&
      ['take_items', 'put_items'].includes(action.action_type) &&
      typeof action.slot === 'string' &&
      ['input', 'fuel', 'output'].includes(action.slot) &&
      typeof action.item === 'string' &&
      (typeof action.count === 'number' || action.count === 'all')
    );
  }

  /**
   * 执行单个熔炉动作
   */
  private async executeFurnaceAction(action: FurnaceAction): Promise<{ success: boolean; message: string }> {
    if (!this.position || !this.state) {
      return { success: false, message: '熔炉位置或状态未设置' };
    }

    try {
      const count = action.count === 'all' ? 999 : action.count;

      const result = await this.state.context.executor.execute(ActionIds.MANAGE_CONTAINER, {
        position: this.position,
        action: action.action_type,
        slot: action.slot,
        item: action.item,
        count: count,
      });

      // 记录到思考日志
      if (this.state.memory) {
        const actionText = action.action_type === 'take_items' ? '取出' : '放入';
        this.state.memory.recordThought(`🔥 熔炉操作: ${actionText} ${action.item} x${action.count} (${action.slot}槽)`);
      }

      return result;
    } catch (error) {
      this.logger.error('❌ 熔炉动作执行异常:', undefined, error as Error);
      return { success: false, message: `执行异常: ${error}` };
    }
  }

  /**
   * 清理熔炉状态
   */
  private clearFurnaceState(): void {
    this.inputSlot = {};
    this.fuelSlot = {};
    this.outputSlot = {};
  }

  /**
   * 获取熔炉统计信息
   */
  getFurnaceStats(): {
    position: BlockPosition | null;
    inputCount: number;
    fuelCount: number;
    outputCount: number;
  } {
    return {
      position: this.position,
      inputCount: Object.values(this.inputSlot).reduce((sum, count) => sum + count, 0),
      fuelCount: Object.values(this.fuelSlot).reduce((sum, count) => sum + count, 0),
      outputCount: Object.values(this.outputSlot).reduce((sum, count) => sum + count, 0),
    };
  }

  /**
   * 等待方法（用于动作间隔）
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
