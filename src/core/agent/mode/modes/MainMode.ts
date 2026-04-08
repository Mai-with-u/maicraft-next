/**
 * 主模式
 *
 * 参考原maicraft的MainMode设计
 * 负责正常的探索、任务执行和LLM决策
 * 不实现监听器，专注于主动决策
 */

import { BaseMode } from '@/core/agent/mode/BaseMode';
import { ModeManager } from '@/core/agent/mode/ModeManager';
import type { RuntimeContext } from '@/core/context/RuntimeContext';
import type { AgentState } from '@/core/agent/types';
import { LLMManager } from '@/llm/LLMManager';
import { promptManager, initAllTemplates } from '@/core/agent/prompt';
import { ActionPromptGenerator } from '@/core/actions/ActionPromptGenerator';
import { PromptDataCollector } from '@/core/agent/prompt/PromptDataCollector';
import { getLogger } from '@/utils/Logger';
import { StructuredOutputManager } from '@/core/agent/structured/StructuredOutputManager';
import type { StructuredAction } from '@/core/agent/structured/ActionSchema';

export class MainMode extends BaseMode {
  readonly type = ModeManager.MODE_TYPES.MAIN;
  readonly name = '主模式';
  readonly description = '正常探索和任务执行';
  readonly priority = 0; // 最低优先级，默认模式
  readonly requiresLLMDecision = true; // 需要LLM参与决策

  // GameStateListener 实现
  readonly listenerName = 'MainMode';
  readonly enabled = false; // 主模式不需要监听游戏状态

  // 主模式特定状态
  private llmManager: LLMManager | null = null;
  private actionPromptGenerator: ActionPromptGenerator | null = null;
  private dataCollector: PromptDataCollector | null = null;
  private promptsInitialized: boolean = false;
  private structuredOutputManager: StructuredOutputManager | null = null;

  constructor(context: RuntimeContext) {
    super(context);
    // 重新设置logger以使用正确的名称
    this.logger = getLogger(this.name);
  }

  /**
   * 绑定Agent状态并初始化LLM组件
   */
  bindState(state: AgentState): void {
    super.bindState(state);

    if (state) {
      // 初始化LLM相关组件
      this.llmManager = state.llmManager;

      // 初始化提示词模板（只初始化一次）
      if (!this.promptsInitialized) {
        initAllTemplates();
        this.promptsInitialized = true;
        this.logger.info('✅ 主模式提示词模板初始化完成');
      }

      // 创建动作提示词生成器和数据收集器
      if (this.llmManager) {
        this.actionPromptGenerator = new ActionPromptGenerator(state.context.executor);
        this.dataCollector = new PromptDataCollector(state, this.actionPromptGenerator);
        // 创建结构化输出管理器
        // TODO: 临时禁用结构化输出，使用降级解析方案
        this.structuredOutputManager = new StructuredOutputManager(this.llmManager, {
          useStructuredOutput: false, // 暂时使用手动解析
        });
      }
    }
  }

  /**
   * 激活模式
   */
  protected async onActivate(reason: string): Promise<void> {
    this.logger.info(`🚀 进入主模式: ${reason}`);

    // 记录到思考日志
    if (this.state?.memory) {
      this.state.memory.recordThought(`🚀 切换到主模式: ${reason}`);
    }
  }

  /**
   * 停用模式
   */
  protected async onDeactivate(reason: string): Promise<void> {
    this.logger.info(`⏸️ 退出主模式: ${reason}`);

    // 记录到思考日志
    if (this.state?.memory) {
      this.state.memory.recordThought(`⏸️ 退出主模式: ${reason}`);
    }
  }

  /**
   * 模式主逻辑 - LLM决策
   * 参考原maicraft的next_thinking方法
   */
  async execute(): Promise<void> {
    if (!this.state || !this.llmManager || !this.dataCollector) {
      const missingComponents = [];
      if (!this.state) missingComponents.push('state');
      if (!this.llmManager) missingComponents.push('llmManager');
      if (!this.dataCollector) missingComponents.push('dataCollector');

      this.logger.warn(`⚠️ 主模式缺少必要组件: ${missingComponents.join(', ')}`);
      this.logger.debug(`组件状态 - state: ${!!this.state}, llmManager: ${!!this.llmManager}, dataCollector: ${!!this.dataCollector}`);
      return;
    }

    try {
      // 执行LLM决策
      await this.executeLLMDecision();
    } catch (error) {
      this.logger.error('❌ 主模式执行异常:', undefined, error as Error);

      if (this.state?.memory) {
        this.state.memory.recordThought(`❌ 主模式执行异常: ${error}`);
      }
    }
  }

  /**
   * 检查自动转换
   */
  async checkTransitions(): Promise<string[]> {
    const targetModes: string[] = [];

    // 主模式通常不会主动转换，由监听器触发
    // 但可以添加一些基本的转换条件
    if (this.shouldEnterCombat()) {
      targetModes.push(ModeManager.MODE_TYPES.COMBAT);
    }

    return targetModes;
  }

  /**
   * 执行LLM决策
   * 使用结构化输出，不再依赖不可靠的正则表达式解析
   */
  private async executeLLMDecision(): Promise<void> {
    if (!this.structuredOutputManager) {
      this.logger.error('❌ 结构化输出管理器未初始化');
      return;
    }

    // 收集决策数据
    const promptData = await this.dataCollector!.collectAllData();

    // 展开组合数据结构，保持与模板兼容
    const expandedPromptData = {
      ...promptData.baseInfo, // 展开基础信息
      ...promptData.actionData, // 展开动作数据
      ...promptData.memoryData, // 展开记忆数据
      role_description: promptData.role_description,
      basic_info: promptData.basic_info,
    };

    // 生成提示词
    const prompt = promptManager.generatePrompt('main_thinking', expandedPromptData);

    // 生成系统提示词，包含动作信息（传递上下文以启用动作过滤）
    const actionPromptGenerator = new ActionPromptGenerator(this.state!.context.executor);
    const availableActions = actionPromptGenerator.generatePrompt(this.state!.context);
    const eatAction = actionPromptGenerator.generateActionPrompt('eat' as any);
    const killMobAction = actionPromptGenerator.generateActionPrompt('kill_mob' as any);

    const systemPrompt = promptManager.generatePrompt('main_thinking_system', {
      bot_name: this.state!.config.minecraft.username || this.state!.context.gameState.playerName || 'MaicraftBot',
      player_name: this.state!.config.minecraft.username || this.state!.context.gameState.playerName || 'MaicraftBot',
      available_actions: availableActions,
      eat_action: eatAction,
      kill_mob_action: killMobAction,
    });

    this.logger.debug('💭 生成提示词完成');

    // 使用结构化输出管理器请求LLM
    const structuredResponse = await this.structuredOutputManager.requestMainActions(prompt, systemPrompt);

    if (!structuredResponse) {
      this.logger.warn('⚠️ LLM结构化输出获取失败');
      return;
    }

    this.logger.info('🤖 LLM 响应完成');

    // 记录LLM的思维过程
    if (structuredResponse.thinking) {
      this.state!.memory.recordThought(`🤔 LLM思维: ${structuredResponse.thinking}`, {
        context: 'main_decision',
        prompt: prompt.substring(0, 200) + '...',
        mode: 'main',
      });
    }

    // 执行单个结构化动作
    if (structuredResponse.action) {
      await this.executeStructuredAction(structuredResponse.action);
    } else {
      this.logger.warn('⚠️ LLM响应中没有action字段');
    }
  }

  /**
   * 清理动作参数，去除重复的元数据字段
   */
  private cleanActionParams(action: StructuredAction): Record<string, any> {
    const cleaned = { ...action } as Record<string, any>;
    // 去除元数据字段，只保留动作参数
    delete cleaned.intention;
    delete cleaned.action_type;

    if (cleaned.message != null && typeof cleaned.message !== 'string') {
      try {
        cleaned.message = JSON.stringify(cleaned.message);
      } catch {
        cleaned.message = String(cleaned.message);
      }
    }

    return cleaned;
  }

  /**
   * 执行单个结构化动作
   * 不再需要JSON解析，直接获得结构化的动作对象
   */
  private async executeStructuredAction(action: StructuredAction): Promise<void> {
    if (!action) {
      this.logger.warn('⚠️ 动作为空');
      return;
    }

    const actionName = action.action_type;
    const actionIntention = action.intention || `执行${actionName}操作`;

    this.logger.info(`🎬 执行动作: ${actionName} - 意图: ${actionIntention}`);
    this.logger.debug(`🔍 动作详情: ${JSON.stringify(action, null, 2)}`);

    // 记录动作信息 - 构建干净的动作记录结构
    const actionRecord = {
      actionType: actionName,
      params: this.cleanActionParams(action),
    };

    // 检查是否是GUI操作，需要切换模式
    if (this.isGUIAction(actionName)) {
      const modeSwitchResult = await this.handleGUIAction(actionName, action);
      if (modeSwitchResult) {
        this.logger.info(`✅ 动作成功: 切换到${modeSwitchResult}模式`);
        // 记录成功的决策
        this.state!.memory.recordDecision(actionIntention, actionRecord, 'success', `切换到${modeSwitchResult}模式`);
      } else {
        this.logger.warn('⚠️ GUI模式切换失败');
        this.state!.memory.recordDecision(actionIntention, actionRecord, 'failed', 'GUI模式切换失败');
      }
    } else {
      // 执行普通动作
      try {
        // 类型安全：将 actionName 断言为 ActionId（动作名称已经过验证）
        const result = await this.state!.context.executor.execute(actionName as any, action);

        if (result.success) {
          this.logger.info(`✅ 动作成功: ${result.message}`);
          this.state!.memory.recordDecision(actionIntention, actionRecord, 'success', result.message);
        } else {
          this.logger.warn(`⚠️ 动作失败: ${result.message}`);
          this.state!.memory.recordDecision(actionIntention, actionRecord, 'failed', result.message);
        }
      } catch (executeError) {
        this.logger.error(`❌ 动作执行异常:`, undefined, executeError as Error);
        this.state!.memory.recordDecision(actionIntention, actionRecord, 'failed', `执行异常: ${(executeError as Error).message}`);
      }
    }
  }

  /**
   * 判断是否应该进入战斗
   * 基础威胁检测，主要依赖CombatMode的监听器
   */
  private shouldEnterCombat(): boolean {
    if (!this.state?.context?.gameState?.nearbyEntities) {
      return false;
    }

    const hostileMobs = ['zombie', 'skeleton', 'spider', 'creeper'];
    const entities = this.state.context.gameState.nearbyEntities || [];
    const enemies = entities.filter((e: any) => hostileMobs.includes(e.name?.toLowerCase()));

    return enemies.length > 0 && (enemies[0].distance ?? 100) < 10;
  }

  /**
   * 判断是否是GUI操作
   */
  private isGUIAction(actionName: string): boolean {
    return actionName === 'open_furnace_gui' || actionName === 'open_chest_gui';
  }

  /**
   * 处理GUI操作，切换到相应模式
   */
  private async handleGUIAction(actionName: string, actionJson: any): Promise<string | null> {
    if (!this.state || !this.state.modeManager) {
      this.logger.warn('⚠️ 无法切换GUI模式：状态或模式管理器不可用');
      return null;
    }

    try {
      let targetMode: string | null = null;
      let position: any = null;

      if (actionName === 'open_furnace_gui') {
        targetMode = ModeManager.MODE_TYPES.FURNACE_GUI;
        position = actionJson.position || actionJson.params?.position;
      } else if (actionName === 'open_chest_gui') {
        targetMode = ModeManager.MODE_TYPES.CHEST_GUI;
        position = actionJson.position || actionJson.params?.position;
      }

      if (!targetMode) {
        this.logger.warn(`⚠️ 未知的GUI操作: ${actionName}`);
        return null;
      }

      // 获取目标模式实例
      const modeInstance = this.state.modeManager.getAllModes().find(mode => mode.type === targetMode);
      if (!modeInstance) {
        this.logger.warn(`⚠️ 找不到GUI模式: ${targetMode}`);
        return null;
      }

      // 设置位置（如果是位置相关的GUI模式）
      if (position && 'setPosition' in modeInstance) {
        (modeInstance as any).setPosition(position);
      }

      // 切换到GUI模式
      try {
        // 🔧 设置中断，让主循环暂停调度
        if (this.state.interrupt) {
          this.state.interrupt.trigger(`GUI模式执行中: ${targetMode}`);
        }

        // 🔧 暂停方块扫描，避免占用事件循环
        const cacheManager = (this.state.context.gameState as any).cacheManager;
        if (cacheManager && typeof cacheManager.pauseScanning === 'function') {
          cacheManager.pauseScanning();
          this.logger.debug('⏸️ 已暂停方块扫描');
        }

        await this.state.modeManager.setMode(targetMode, `LLM决策使用${actionName}`);

        // 🔧 关键修复：立即执行 GUI 模式，并等待完成
        // 这样主循环就不会在 GUI 模式执行期间继续调度
        this.logger.info(`🔄 开始执行 ${targetMode} 模式...`);

        const guiMode = this.state.modeManager.getAllModes().find(mode => mode.type === targetMode);
        if (guiMode) {
          await guiMode.execute();
          this.logger.info(`✅ ${targetMode} 模式执行完成`);
        }

        // GUI 模式执行完毕后，切换回主模式
        await this.state.modeManager.setMode(ModeManager.MODE_TYPES.MAIN, `${targetMode}模式执行完成`);

        // 清除中断标志并恢复扫描
        if (this.state.interrupt) {
          this.state.interrupt.clear();
        }

        // 🔧 恢复方块扫描
        if (cacheManager && typeof cacheManager.resumeScanning === 'function') {
          cacheManager.resumeScanning();
          this.logger.debug('▶️ 已恢复方块扫描');
        }

        return targetMode;
      } catch (error) {
        this.logger.warn(`⚠️ 切换到${targetMode}模式失败: ${(error as Error).message}`);

        // 发生错误时也要切换回主模式并恢复扫描
        await this.state.modeManager.setMode(ModeManager.MODE_TYPES.MAIN, `${targetMode}模式执行异常`);

        // 清除中断标志
        if (this.state.interrupt) {
          this.state.interrupt.clear();
        }

        // 🔧 恢复方块扫描
        const cacheManager = (this.state.context.gameState as any).cacheManager;
        if (cacheManager && typeof cacheManager.resumeScanning === 'function') {
          cacheManager.resumeScanning();
          this.logger.debug('▶️ 已恢复方块扫描（错误恢复）');
        }

        return null;
      }
    } catch (error) {
      this.logger.error(`❌ 处理GUI操作失败: ${actionName}`, undefined, error as Error);
      return null;
    }
  }

  /**
   * 获取主模式统计信息
   */
  getMainModeStats(): {
    isLLMAvailable: boolean;
    promptsInitialized: boolean;
  } {
    return {
      isLLMAvailable: !!this.llmManager,
      promptsInitialized: this.promptsInitialized,
    };
  }
}
