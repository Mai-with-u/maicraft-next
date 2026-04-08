/**
 * Agent 主类
 * 整个 AI 系统的入口和协调者
 */

import { getLogger } from '@/utils/Logger';
import type { Logger } from '@/utils/Logger';
import type { Bot } from 'mineflayer';
import type { AppConfig as Config } from '@/utils/Config';
import type { AgentState, AgentStatus, GameContext } from './types';
import type { Goal } from './planning/Goal';
import { InterruptController } from './InterruptController';
import { MemoryManager } from './memory/MemoryManager';
import { GoalPlanningManager } from './planning/GoalPlanningManager';
import { ModeManager } from './mode/ModeManager';
import { MainDecisionLoop } from './loop/MainDecisionLoop';
import { ChatLoop } from './loop/ChatLoop';
import { ActionExecutor } from '@/core/actions/ActionExecutor';
import { PromptDataCollector } from './prompt/PromptDataCollector';
import { ActionPromptGenerator } from '@/core/actions/ActionPromptGenerator';

export class Agent {
  // 共享状态（只读）
  readonly state: AgentState;

  // 决策系统（作为内部组件，不暴露）
  private mainLoop: MainDecisionLoop;
  private chatLoop: ChatLoop;

  // 数据收集器
  private dataCollector: PromptDataCollector;

  // 外部传入的组件
  private bot: Bot;
  private executor: ActionExecutor;
  private llmManager: any; // LLMManager 类型
  private externalLogger: Logger;

  // 生命周期
  private isRunning: boolean = false;

  private logger: Logger;

  constructor(
    bot: Bot,
    executor: ActionExecutor,
    llmManager: any,
    config: Config,
    memory: MemoryManager,
    planningManager: GoalPlanningManager,
    modeManager: ModeManager,
    interrupt: InterruptController,
    logger?: Logger,
  ) {
    this.bot = bot;
    this.executor = executor;
    this.llmManager = llmManager;
    this.externalLogger = logger || getLogger('Agent');
    this.logger = this.externalLogger;

    // 从外部注入的组件构建状态
    const context = this.executor.getContextManager().getContext();

    this.state = {
      goal: config.agent?.goal || '探索世界',
      isRunning: false,
      context,
      modeManager,
      planningManager,
      memory,
      llmManager: this.llmManager,
      interrupt,
      config,
    };

    // 绑定状态到 ModeManager
    this.state.modeManager.bindState(this.state);

    // 设置规划管理器的目标完成回调
    this.state.planningManager.setOnGoalCompleted((goal: Goal) => {
      this.handleGoalCompletion(goal);
    });

    // 创建决策循环（依赖 AgentState，在这里创建）
    this.mainLoop = new MainDecisionLoop(this.state, this.llmManager);
    this.chatLoop = new ChatLoop(this.state, this.llmManager);

    // 初始化数据收集器（用于目标生成）
    const actionPromptGenerator = new ActionPromptGenerator(this.executor);
    this.dataCollector = new PromptDataCollector(this.state, actionPromptGenerator);

    // 设置事件监听
    this.setupEventListeners();

    // 设置定期保存记忆
    this.setupPeriodicSave();
  }

  /**
   * 设置WebSocket服务器（用于记忆推送）
   */
  setWebSocketServer(webSocketServer: any): void {
    this.state.memory.setWebSocketServer(webSocketServer);
    this.logger.info('📡 Agent 已连接到WebSocket服务器');
  }

  /**
   * 获取记忆管理器
   */
  getMemoryManager(): any {
    return this.state.memory;
  }

  /**
   * 初始化 Agent（加载资源、设置状态等，但不启动决策循环）
   */
  async initialize(): Promise<void> {
    this.logger.info('🔧 Agent 初始化中...');

    try {
      // 初始化游戏状态（如果还没初始化）
      if (!(this.state.context.gameState as any).initialized) {
        this.state.context.gameState.initialize(this.state.context.bot);
      }

      // 注意：MemoryManager 和 GoalPlanningManager 已由 DI 容器的 withInitializer 初始化过
      // 不要在这里重复调用 initialize()，否则会导致双重初始化

      // 如果配置中有目标但规划系统中没有，创建初始目标
      if (this.state.goal && !this.state.planningManager.getCurrentGoal()) {
        this.logger.info(`🎯 从配置创建初始目标: ${this.state.goal}`);
        this.state.planningManager.createGoal(this.state.goal);
      }

      // 注册所有模式
      await this.state.modeManager.registerModes();

      this.logger.info('✅ Agent 初始化完成');
    } catch (error) {
      this.logger.error('❌ Agent 初始化失败:', undefined, error as Error);
      throw error;
    }
  }

  /**
   * 启动 Agent（开始决策循环）
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Agent 已在运行');
      return;
    }

    this.isRunning = true;
    this.state.isRunning = true;

    this.logger.info('🚀 Agent 启动中...');

    try {
      // 设置初始模式
      await this.state.modeManager.setMode(ModeManager.MODE_TYPES.MAIN, '初始化');

      // 启动决策循环
      this.mainLoop.start();
      this.chatLoop.start();

      this.logger.info('✅ Agent 启动完成');
    } catch (error) {
      this.logger.error('❌ Agent 启动失败:', undefined, error as Error);
      this.isRunning = false;
      this.state.isRunning = false;
      throw error;
    }
  }

  /**
   * 停止 Agent
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Agent 未在运行');
      return;
    }

    this.logger.info('🛑 Agent 停止中...');

    this.isRunning = false;
    this.state.isRunning = false;

    // 清理定期保存定时器，防止重连时多个定时器累积
    if (this.periodicSaveInterval) {
      clearInterval(this.periodicSaveInterval);
      this.periodicSaveInterval = undefined;
    }

    // 停止决策循环
    this.mainLoop.stop();
    this.chatLoop.stop();

    // 停止规划系统
    this.state.planningManager.stop();

    // 保存状态
    await this.saveState();

    this.logger.info('✅ Agent 已停止');
  }

  private periodicSaveInterval?: NodeJS.Timeout;

  /**
   * 设置定期保存记忆
   */
  private setupPeriodicSave(): void {
    // 每30秒保存一次记忆，保存 interval ID 以便在 stop() 时清理
    this.periodicSaveInterval = setInterval(async () => {
      try {
        await this.state.memory.saveAll();
      } catch (error) {
        this.logger.error('定期保存记忆失败', undefined, error as Error);
      }
    }, 30 * 1000);
  }

  /**
   * 处理目标完成事件
   */
  private handleGoalCompletion(goal: Goal): void {
    // 1. 记录目标完成事件到思考记忆
    this.state.memory.recordThought(`成功完成了目标: ${goal.description}`, {
      completedGoal: goal.description,
      duration: Date.now() - goal.createdAt,
      planCount: goal.planIds.length,
    });

    // 2. 触发"目标完成"事件通知
    this.state.context.events.emit('goalCompleted', {
      goal: {
        id: goal.id,
        description: goal.description,
        completedAt: goal.completedAt,
        duration: goal.completedAt ? goal.completedAt - goal.createdAt : 0,
        planCount: goal.planIds.length,
      },
    });

    // 3. 自动生成新目标
    this.generateNewGoalAfterCompletion(goal);
  }

  /**
   * 基于完成的目标自动生成新目标
   */
  private async generateNewGoalAfterCompletion(completedGoal: Goal): Promise<void> {
    try {
      // 🔧 关键修复：检查中断标志，如果正在执行 GUI 模式，延迟生成新目标
      if (this.state.interrupt.isInterrupted()) {
        const reason = this.state.interrupt.getReason();
        this.logger.info(`⏸️ 检测到中断标志（${reason}），延迟生成新目标`);

        // 等待中断解除后再生成新目标
        setTimeout(() => {
          if (!this.state.interrupt.isInterrupted()) {
            this.generateNewGoalAfterCompletion(completedGoal);
          }
        }, 2000); // 2秒后重试

        return;
      }

      this.logger.info('🤖 正在分析环境，生成新目标...');

      // 记录思考过程
      this.state.memory.recordThought('🤖 分析已完成目标，准备生成新目标', {
        completedGoal: completedGoal.description,
      });

      // 1. 收集环境信息
      const environmentData = this.collectEnvironmentData();

      // 2. 获取历史目标信息
      const completedGoalsHistory = this.getCompletedGoalsHistory();

      // 3. 调用LLM生成新目标
      const newGoalData = await this.generateGoalWithLLM(completedGoal, environmentData, completedGoalsHistory);

      if (newGoalData) {
        // 4. 创建新目标
        await this.createNewGoal(newGoalData);
      } else {
        // 如果LLM生成失败，记录并等待用户指令
        this.logger.warn('🎯 LLM目标生成失败，暂时等待用户指令');
        this.state.memory.recordThought('🎯 LLM目标生成失败，等待用户指令', {});
      }
    } catch (error) {
      this.logger.error('自动目标生成失败:', {}, error as Error);
      this.state.memory.recordThought('🎯 自动目标生成出错，等待用户指令', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * 收集当前环境数据，用于目标生成
   */
  private collectEnvironmentData(): any {
    const gameState = this.state.context.gameState;
    // 使用PromptDataCollector收集的基础信息，获得格式化的数据
    const basicInfo = this.dataCollector.collectBasicInfo();

    return {
      position: basicInfo.position, // "位置: (x, y, z)"
      health: gameState.health || 20,
      food: gameState.food || 20,
      inventory: basicInfo.inventory_info, // 格式化的物品栏信息
      time: gameState.timeOfDay > 12000 ? '夜晚' : '白天',
      environment: gameState.getStatusDescription(), // 完整的状态描述
    };
  }

  /**
   * 获取已完成目标的历史
   */
  private getCompletedGoalsHistory(): any[] {
    const goals = this.state.planningManager.getAllGoals();
    const completedGoals = Array.from(goals.values())
      .filter((goal: Goal) => goal.status === 'completed')
      .map((goal: Goal) => ({
        description: goal.description,
        createdAt: goal.createdAt,
        completedAt: goal.completedAt,
        duration: goal.completedAt ? goal.completedAt - goal.createdAt : 0,
        planCount: goal.planIds.length,
      }))
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)) // 按完成时间倒序
      .slice(0, 10); // 只取最近10个

    return completedGoals;
  }

  /**
   * 使用LLM生成新目标
   */
  private async generateGoalWithLLM(completedGoal: Goal, environmentData: any, completedGoalsHistory: any[]): Promise<any> {
    try {
      const { promptManager } = await import('@/core/agent/prompt');

      const promptData = {
        completed_goals: completedGoalsHistory.map(g => `- ${g.description} (${Math.round(g.duration / 60000)}分钟)`).join('\n'),
        position: environmentData.position
          ? `${environmentData.position.x}, ${environmentData.position.y}, ${environmentData.position.z}`
          : '未知位置',
        health: environmentData.health,
        food: environmentData.food,
        inventory: environmentData.inventory,
        time: environmentData.time, // 已经是字符串 '夜晚'/'白天'，不要再重复判断
        environment: environmentData.environment,
        experiences: this.state.memory.experience
          .getRecent(5)
          .map((e: any) => e.content)
          .join('\n'), // 最近5条经验
      };

      const response = await this.llmManager.chatCompletion(
        promptManager.generatePrompt('goal_generation', promptData),
        '你是一个Minecraft游戏助手，需要生成合适的下一个游戏目标。',
      );

      if (!response.success) {
        this.logger.error('LLM目标生成请求失败:', response.error);
        return null;
      }

      // 解析响应：先尝试直接解析，再用 jsonrepair 修复，最后尝试提取代码块
      const content = response.content?.trim() || '';
      let goalData: any = null;

      // 尝试1：直接 JSON.parse
      try {
        goalData = JSON.parse(content);
      } catch {
        // 尝试2：提取 ```json``` 代码块
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
          try {
            goalData = JSON.parse(jsonMatch[1]);
          } catch { /* 继续 */ }
        }

        // 尝试3：用 jsonrepair 修复
        if (!goalData) {
          try {
            const { jsonrepair } = await import('jsonrepair');
            goalData = JSON.parse(jsonrepair(content));
          } catch {
            this.logger.error('LLM目标生成：无法解析响应为 JSON');
            return null;
          }
        }
      }

      // 验证必需字段
      if (!goalData.goal || !goalData.reasoning) {
        this.logger.error('LLM响应缺少必需字段');
        return null;
      }

      this.logger.info(`🎯 LLM生成新目标: ${goalData.goal}`);
      return goalData;
    } catch (error) {
      this.logger.error('LLM目标生成解析失败:', {}, error as Error);
      return null;
    }
  }

  /**
   * 创建新目标并自动生成计划
   */
  private async createNewGoal(goalData: any): Promise<void> {
    try {
      // 记录生成的目标信息
      this.state.memory.recordThought(`🎯 生成新目标: ${goalData.goal}`, {
        reasoning: goalData.reasoning,
        difficulty: goalData.difficulty,
        estimatedTime: goalData.estimated_time,
        priority: goalData.priority,
        category: goalData.category,
      });

      // 创建新目标
      const goal = await this.state.planningManager.createGoal(goalData.goal);

      this.logger.info(`✅ 新目标已创建: ${goalData.goal}`);

      // 自动生成计划
      await this.generatePlanForNewGoal(goal);
    } catch (error) {
      this.logger.error('创建新目标失败:', {}, error as Error);
    }
  }

  /**
   * 为新目标生成计划
   */
  private async generatePlanForNewGoal(goal: Goal): Promise<void> {
    try {
      this.logger.info('📋 正在为新目标生成计划...');

      // 调用规划管理器的计划生成方法
      const success = await this.state.planningManager.generatePlanForCurrentGoal();

      if (success) {
        this.logger.info('✅ 新目标的计划已生成完成');
      } else {
        this.logger.warn('⚠️ 新目标的计划生成失败');
        this.state.memory.recordThought('⚠️ 新目标计划生成失败，可能需要手动规划', {
          goal: goal.description,
        });
      }
    } catch (error) {
      this.logger.error('为新目标生成计划失败:', {}, error as Error);
    }
  }

  /**
   * 设置事件监听（游戏逻辑相关）
   */
  private setupEventListeners(): void {
    const { context, interrupt, modeManager } = this.state;

    // 受伤事件 - 切换到战斗模式
    context.events.on('entityHurt', async (data: any) => {
      if (data.entity?.id === context.bot.entity?.id) {
        // 只有当受伤的是自己时才切换模式
        await modeManager.trySetMode(ModeManager.MODE_TYPES.COMBAT, '受到攻击');
        this.state.memory.recordThought('⚔️ 受到攻击，切换到战斗模式', { entity: data.entity });
      }
    });

    // 死亡事件 - 触发中断
    context.events.on('death', () => {
      interrupt.trigger('玩家死亡');
      this.logger.warn('💀 玩家死亡');
      this.state.memory.recordThought('💀 玩家死亡，需要重生', {});
    });

    // 重生事件 - 恢复正常状态
    context.events.on('spawn', () => {
      this.logger.info('🎮 玩家重生');
      this.state.memory.recordThought('🎮 玩家重生，恢复正常活动', {});
    });

    // 健康和饥饿状态变化 - AI决策相关
    context.events.on('health', (data: any) => {
      const { health, food } = data;

      // 低血量警告
      if (health < 6) {
        this.state.memory.recordThought('⚠️ 生命值过低，需要回血或进食', { health });
      }

      // 低饥饿值警告
      if (food < 6) {
        this.state.memory.recordThought('⚠️ 饥饿值过低，需要进食', { food });
      }

      // 记录健康状态变化
      this.logger.debug(`健康状态更新: 生命值 ${health}/20, 饥饿值 ${food}/20`);
    });
  }

  /**
   * 保存状态
   */
  private async saveState(): Promise<void> {
    this.logger.info('💾 保存 Agent 状态...');

    try {
      await Promise.all([
        this.state.memory.saveAll(),
        this.state.context.blockCache.save?.(),
        this.state.context.containerCache.save?.(),
        this.state.context.locationManager.save?.(),
      ]);

      this.logger.info('✅ Agent 状态保存完成');
    } catch (error) {
      this.logger.error('❌ 保存 Agent 状态失败:', {}, error as Error);
    }
  }

  /**
   * 获取状态摘要
   */
  getStatus(): AgentStatus {
    return {
      isRunning: this.isRunning,
      currentMode: this.state.modeManager.getCurrentMode(),
      goal: this.state.goal,
      currentTask: this.state.planningManager.getCurrentTask(),
      interrupted: this.state.interrupt.isInterrupted(),
      interruptReason: this.state.interrupt.getReason(),
    };
  }

  /**
   * 设置目标
   */
  setGoal(description: string): void {
    (this.state as any).goal = description;
    this.state.planningManager.createGoal(description);
    this.logger.info(`🎯 设置新目标: ${description}`);
  }
}
