/**
 * 结构化输出管理器
 *
 * 负责处理 LLM 的结构化输出，支持两种模式：
 * 1. JSON Schema 模式（OpenAI Structured Outputs）- 最可靠
 * 2. 降级模式（手动解析JSON）- 兼容性方案
 */

import { getLogger } from '@/utils/Logger';
import type { LLMManager } from '@/llm/LLMManager';
import {
  ACTION_RESPONSE_SCHEMA,
  CHEST_OPERATION_SCHEMA,
  FURNACE_OPERATION_SCHEMA,
  PLAN_GENERATION_SCHEMA,
  TASK_EVALUATION_SCHEMA,
  StructuredLLMResponse,
  StructuredAction,
  ExperienceSummaryResponse,
  PlanGenerationResponse,
  TaskEvaluationResponse,
} from './ActionSchema';

const logger = getLogger('StructuredOutputManager');

export interface StructuredOutputOptions {
  useStructuredOutput?: boolean; // 是否使用原生结构化输出
  maxRetries?: number; // 解析失败时的重试次数
}

/**
 * 结构化输出管理器类
 */
export class StructuredOutputManager {
  private llmManager: LLMManager;
  private useStructuredOutput: boolean;

  /**
   * 测试JSON解析功能（用于调试）
   */
  static testJsonParsing(jsonString: string): ExperienceSummaryResponse | null {
    try {
      const parsed = JSON.parse(jsonString);
      const manager = new StructuredOutputManager(null as any, { useStructuredOutput: true });
      return manager.validateExperienceResponse(parsed);
    } catch (error) {
      logger.error('测试JSON解析失败', undefined, error as Error);
      return null;
    }
  }

  constructor(llmManager: LLMManager, options: StructuredOutputOptions = {}) {
    this.llmManager = llmManager;
    // 检查 LLM 提供商是否支持结构化输出
    // 默认启用，但可以通过选项禁用
    this.useStructuredOutput = options.useStructuredOutput ?? true;
  }

  /**
   * 请求主模式动作决策（结构化输出）
   */
  async requestMainActions(prompt: string, systemPrompt?: string): Promise<StructuredLLMResponse | null> {
    try {
      if (this.useStructuredOutput) {
        // 使用原生结构化输出（OpenAI JSON Schema）
        return await this.requestWithStructuredOutput(prompt, systemPrompt, ACTION_RESPONSE_SCHEMA);
      } else {
        // 降级到手动解析
        return await this.requestWithManualParsing(prompt, systemPrompt);
      }
    } catch (error) {
      logger.error('请求主模式动作失败', undefined, error as Error);
      return null;
    }
  }

  /**
   * 请求箱子操作（结构化输出）
   */
  async requestChestOperations(prompt: string, systemPrompt?: string): Promise<StructuredLLMResponse | null> {
    try {
      if (this.useStructuredOutput) {
        return await this.requestWithStructuredOutput(prompt, systemPrompt, CHEST_OPERATION_SCHEMA);
      } else {
        return await this.requestWithManualParsing(prompt, systemPrompt);
      }
    } catch (error) {
      logger.error('请求箱子操作失败', undefined, error as Error);
      return null;
    }
  }

  /**
   * 请求熔炉操作（结构化输出）
   */
  async requestFurnaceOperations(prompt: string, systemPrompt?: string): Promise<StructuredLLMResponse | null> {
    try {
      if (this.useStructuredOutput) {
        return await this.requestWithStructuredOutput(prompt, systemPrompt, FURNACE_OPERATION_SCHEMA);
      } else {
        return await this.requestWithManualParsing(prompt, systemPrompt);
      }
    } catch (error) {
      logger.error('请求熔炉操作失败', undefined, error as Error);
      return null;
    }
  }

  /**
   * 请求经验总结（结构化输出）
   */
  async requestExperienceSummary(prompt: string, systemPrompt?: string): Promise<ExperienceSummaryResponse | null> {
    try {
      logger.debug('开始请求经验总结', {
        useStructuredOutput: this.useStructuredOutput,
        promptLength: prompt.length,
        systemPromptLength: systemPrompt?.length || 0,
      });

      if (this.useStructuredOutput) {
        return await this.requestExperienceWithStructuredOutput(prompt, systemPrompt);
      } else {
        return await this.requestExperienceWithManualParsing(prompt, systemPrompt);
      }
    } catch (error) {
      logger.error('请求经验总结失败', undefined, error as Error);
      return null;
    }
  }

  /**
   * 请求规划生成（结构化输出）
   */
  async requestPlanGeneration(prompt: string, systemPrompt?: string): Promise<PlanGenerationResponse | null> {
    try {
      logger.debug('开始请求规划生成', {
        useStructuredOutput: this.useStructuredOutput,
        promptLength: prompt.length,
        systemPromptLength: systemPrompt?.length || 0,
      });

      if (this.useStructuredOutput) {
        return await this.requestPlanWithStructuredOutput(prompt, systemPrompt);
      } else {
        return await this.requestPlanWithManualParsing(prompt, systemPrompt);
      }
    } catch (error) {
      logger.error('请求规划生成失败', undefined, error as Error);
      return null;
    }
  }

  /**
   * 请求任务评估（结构化输出）
   */
  async requestTaskEvaluation(prompt: string, systemPrompt?: string): Promise<TaskEvaluationResponse | null> {
    try {
      logger.debug('开始请求任务评估', {
        useStructuredOutput: this.useStructuredOutput,
        promptLength: prompt.length,
        systemPromptLength: systemPrompt?.length || 0,
      });

      if (this.useStructuredOutput) {
        return await this.requestTaskEvaluationWithStructuredOutput(prompt, systemPrompt);
      } else {
        return await this.requestTaskEvaluationWithManualParsing(prompt, systemPrompt);
      }
    } catch (error) {
      logger.error('请求任务评估失败', undefined, error as Error);
      return null;
    }
  }

  /**
   * 使用结构化输出请求规划
   */
  private async requestPlanWithStructuredOutput(prompt: string, systemPrompt: string | undefined): Promise<PlanGenerationResponse | null> {
    try {
      const fullSystemPrompt = systemPrompt
        ? `${systemPrompt}\n\n你必须返回一个有效的JSON对象，包含title、description和tasks字段。`
        : '你必须返回一个有效的JSON对象，包含title、description和tasks字段。';

      logger.debug('调用LLM进行结构化规划生成');

      const response = await this.llmManager.chatCompletion(prompt, fullSystemPrompt, {
        response_format: {
          type: 'json_object',
        },
      });

      if (!response.success || !response.content) {
        logger.error('规划生成LLM调用失败', { error: response.error });
        return null;
      }

      logger.debug('LLM返回内容预览', {
        contentLength: response.content.length,
        contentPreview: response.content.substring(0, 200),
      });

      try {
        const parsed = JSON.parse(response.content);
        logger.debug('JSON解析成功，开始验证响应格式');
        const validated = this.validatePlanResponse(parsed);
        if (validated) {
          logger.debug('规划响应验证通过', { tasksCount: validated.tasks.length });
        } else {
          logger.warn('规划响应验证失败');
        }
        return validated;
      } catch (parseError) {
        logger.error('规划JSON解析失败', {
          error: parseError.message,
          contentPreview: response.content.substring(0, 200),
        });
        return await this.extractPlanResponse(response.content);
      }
    } catch (error) {
      logger.error('结构化规划请求失败', undefined, error as Error);
      return await this.requestPlanWithManualParsing(prompt, systemPrompt);
    }
  }

  /**
   * 手动解析规划
   */
  private async requestPlanWithManualParsing(prompt: string, systemPrompt: string | undefined): Promise<PlanGenerationResponse | null> {
    try {
      const manualPrompt = `${prompt}\n\n请返回一个JSON对象，格式严格如下：
{
  "title": "计划标题",
  "description": "计划描述",
  "tasks": [
    {
      "title": "任务标题",
      "description": "任务描述",
      "tracker": {
        "type": "inventory",
        "itemName": "物品名称",
        "targetCount": 数字
      },
      "dependencies": []
    }
  ]
}

只返回JSON对象，不要有任何其他内容！`;

      logger.debug('使用手动解析模式调用LLM');

      const response = await this.llmManager.chatCompletion(manualPrompt, systemPrompt);

      if (!response.success || !response.content) {
        logger.error('规划生成手动解析LLM调用失败', { error: response.error });
        return null;
      }

      const parsed = this.extractPlanResponse(response.content);

      if (!parsed) {
        logger.warn('无法从响应中提取规划', { content: response.content.substring(0, 200) });
        return null;
      }

      const validated = this.validatePlanResponse(parsed);
      if (validated) {
        logger.debug('手动解析模式验证通过', { tasksCount: validated.tasks.length });
      } else {
        logger.warn('手动解析模式验证失败');
      }

      return validated;
    } catch (error) {
      logger.error('手动解析规划失败', undefined, error as Error);
      return null;
    }
  }

  /**
   * 从文本中提取规划响应
   */
  private extractPlanResponse(text: string): PlanGenerationResponse | null {
    logger.debug('开始手动提取规划响应');

    // 首先尝试直接解析整个文本
    try {
      const parsed = JSON.parse(text);
      if (this.isValidPlanResponse(parsed)) {
        logger.debug('直接解析整个文本成功');
        return parsed;
      }
    } catch (error) {
      logger.debug('直接解析整个文本失败');
    }

    // 尝试找到被 ```json 包裹的内容
    const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        if (this.isValidPlanResponse(parsed)) {
          logger.debug('解析```json代码块成功');
          return parsed;
        }
      } catch (error) {
        logger.debug('解析```json代码块失败');
      }
    }

    // 使用栈方法查找第一个完整的JSON对象
    const jsonObj = this.findFirstCompleteJson(text);
    if (jsonObj) {
      try {
        const parsed = JSON.parse(jsonObj);
        if (this.isValidPlanResponse(parsed)) {
          logger.debug('使用栈方法找到并解析JSON成功');
          return parsed;
        }
      } catch (error) {
        logger.debug('栈方法找到的JSON解析失败');
      }
    }

    logger.warn('所有手动解析方法都失败了');
    return null;
  }

  /**
   * 验证规划响应格式
   */
  private validatePlanResponse(data: any): PlanGenerationResponse | null {
    if (!data || typeof data !== 'object') {
      logger.warn('规划响应不是对象');
      return null;
    }

    if (typeof data.title !== 'string' || !data.title) {
      logger.warn('规划响应缺少有效的title字段');
      return null;
    }

    if (typeof data.description !== 'string' || !data.description) {
      logger.warn('规划响应缺少有效的description字段');
      return null;
    }

    if (!Array.isArray(data.tasks) || data.tasks.length === 0) {
      logger.warn('规划响应缺少有效的tasks数组');
      return null;
    }

    // 验证每个任务
    for (const task of data.tasks) {
      if (!task.title || !task.description || !task.tracker) {
        logger.warn('任务缺少必需字段', { task });
        return null;
      }

      if (!task.tracker.type) {
        logger.warn('任务追踪器缺少type字段', { task });
        return null;
      }

      // 确保dependencies是数组
      if (!task.dependencies) {
        task.dependencies = [];
      } else if (!Array.isArray(task.dependencies)) {
        task.dependencies = [];
      }
    }

    return data as PlanGenerationResponse;
  }

  /**
   * 检查是否是有效的规划响应
   */
  private isValidPlanResponse(data: any): boolean {
    return this.validatePlanResponse(data) !== null;
  }

  /**
   * 使用结构化输出请求经验总结
   */
  private async requestExperienceWithStructuredOutput(prompt: string, systemPrompt: string | undefined): Promise<ExperienceSummaryResponse | null> {
    try {
      const fullSystemPrompt = systemPrompt
        ? `${systemPrompt}\n\n你必须返回一个有效的JSON对象，包含analysis（可选）和lessons（必需）字段。`
        : '你必须返回一个有效的JSON对象，包含analysis（可选）和lessons（必需）字段。';

      logger.debug('调用LLM进行结构化经验总结', {
        fullSystemPromptLength: fullSystemPrompt.length,
        promptPreview: prompt.substring(0, 100) + '...',
      });

      const response = await this.llmManager.chatCompletion(prompt, fullSystemPrompt, {
        response_format: {
          type: 'json_object',
        },
      });

      if (!response.success || !response.content) {
        logger.error('经验总结LLM调用失败', { error: response.error });
        return null;
      }

      logger.debug('LLM返回内容预览', {
        contentLength: response.content.length,
        contentPreview: response.content.substring(0, 200),
      });

      try {
        const parsed = JSON.parse(response.content);
        logger.debug('JSON解析成功，开始验证响应格式');
        const validated = this.validateExperienceResponse(parsed);
        if (validated) {
          logger.debug('经验总结响应验证通过', { lessonsCount: validated.lessons.length });
        } else {
          logger.warn('经验总结响应验证失败');
        }
        return validated;
      } catch (parseError) {
        logger.error('经验总结JSON解析失败', {
          error: parseError.message,
          contentPreview: response.content.substring(0, 200),
        });
        logger.debug('尝试手动提取经验总结响应');
        return await this.extractExperienceResponse(response.content);
      }
    } catch (error) {
      logger.error('结构化经验总结请求失败', undefined, error as Error);
      logger.debug('降级到手动解析模式');
      return await this.requestExperienceWithManualParsing(prompt, systemPrompt);
    }
  }

  /**
   * 手动解析经验总结
   */
  private async requestExperienceWithManualParsing(prompt: string, systemPrompt: string | undefined): Promise<ExperienceSummaryResponse | null> {
    try {
      const manualPrompt = `${prompt}\n\n请返回一个JSON对象，格式如下：
{
  "analysis": "简短的总体分析（可选）",
  "lessons": [
    {
      "lesson": "经验内容，用一句话简短描述",
      "context": "经验的来源或适用场景",
      "confidence": 0.0到1.0之间的数字
    }
  ]
}

只返回JSON对象，不要有任何其他内容！`;

      logger.debug('使用手动解析模式调用LLM', {
        manualPromptLength: manualPrompt.length,
        systemPromptLength: systemPrompt?.length || 0,
      });

      const response = await this.llmManager.chatCompletion(manualPrompt, systemPrompt);

      if (!response.success || !response.content) {
        logger.error('经验总结手动解析LLM调用失败', { error: response.error });
        return null;
      }

      logger.debug('手动解析模式LLM返回内容预览', {
        contentLength: response.content.length,
        contentPreview: response.content.substring(0, 200),
      });

      const parsed = this.extractExperienceResponse(response.content);

      if (!parsed) {
        logger.warn('无法从响应中提取经验总结', { content: response.content.substring(0, 200) });
        return null;
      }

      const validated = this.validateExperienceResponse(parsed);
      if (validated) {
        logger.debug('手动解析模式验证通过', { lessonsCount: validated.lessons.length });
      } else {
        logger.warn('手动解析模式验证失败');
      }

      return validated;
    } catch (error) {
      logger.error('手动解析经验总结失败', undefined, error as Error);
      return null;
    }
  }

  /**
   * 从文本中提取经验总结响应
   */
  private extractExperienceResponse(text: string): ExperienceSummaryResponse | null {
    logger.debug('开始手动提取经验总结响应', { textLength: text.length });

    // 首先尝试直接解析整个文本
    try {
      const parsed = JSON.parse(text);
      if (this.isValidExperienceResponse(parsed)) {
        logger.debug('直接解析整个文本成功');
        return parsed;
      } else {
        logger.debug('直接解析的JSON不满足经验总结格式要求');
      }
    } catch (error) {
      logger.debug('直接解析整个文本失败', { error: error.message });
    }

    // 尝试找到被 ```json 包裹的内容
    const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        if (this.isValidExperienceResponse(parsed)) {
          logger.debug('解析```json代码块成功');
          return parsed;
        } else {
          logger.debug('```json代码块中的JSON不满足经验总结格式要求');
        }
      } catch (error) {
        logger.debug('解析```json代码块失败', { error: error.message });
      }
    } else {
      logger.debug('未找到```json代码块');
    }

    // 使用栈方法查找第一个完整的JSON对象
    const jsonObj = this.findFirstCompleteJson(text);
    if (jsonObj) {
      try {
        const parsed = JSON.parse(jsonObj);
        if (this.isValidExperienceResponse(parsed)) {
          logger.debug('使用栈方法找到并解析JSON成功');
          return parsed;
        } else {
          logger.debug('栈方法找到的JSON不满足经验总结格式要求');
        }
      } catch (error) {
        logger.debug('栈方法找到的JSON解析失败', { error: error.message, jsonObj: jsonObj.substring(0, 100) });
      }
    } else {
      logger.debug('栈方法未找到完整的JSON对象');
    }

    logger.warn('所有手动解析方法都失败了');
    return null;
  }

  /**
   * 检查是否是有效的经验总结响应
   */
  private isValidExperienceResponse(obj: any): boolean {
    return obj && typeof obj === 'object' && Array.isArray(obj.lessons) && obj.lessons.length > 0;
  }

  /**
   * 验证经验总结响应格式
   */
  private validateExperienceResponse(response: any): ExperienceSummaryResponse | null {
    if (!response || typeof response !== 'object') {
      logger.warn('经验总结响应不是对象');
      return null;
    }

    if (!Array.isArray(response.lessons)) {
      logger.warn('经验总结响应缺少lessons数组');
      return null;
    }

    if (response.lessons.length === 0) {
      logger.warn('经验总结lessons数组为空');
      return null;
    }

    // 验证每条经验
    for (const lesson of response.lessons) {
      if (!lesson.lesson || typeof lesson.lesson !== 'string') {
        logger.warn('经验缺少lesson字段或格式不正确', { lesson });
        return null;
      }
      if (!lesson.context || typeof lesson.context !== 'string') {
        logger.warn('经验缺少context字段或格式不正确', { lesson });
        return null;
      }
      if (typeof lesson.confidence !== 'number' || lesson.confidence < 0 || lesson.confidence > 1) {
        logger.warn('经验的confidence字段无效', { lesson });
        return null;
      }
    }

    return response as ExperienceSummaryResponse;
  }

  /**
   * 使用原生结构化输出（JSON对象格式）
   */
  private async requestWithStructuredOutput(prompt: string, systemPrompt: string | undefined, schema: any): Promise<StructuredLLMResponse | null> {
    try {
      // 构建完整的系统提示词
      const fullSystemPrompt = systemPrompt
        ? `${systemPrompt}\n\n你必须返回一个有效的JSON对象，包含thinking（可选）和actions（必需）字段。`
        : '你必须返回一个有效的JSON对象，包含thinking（可选）和actions（必需）字段。';

      // 尝试使用 json_object 格式（OpenAI标准格式）
      const response = await this.llmManager.chatCompletion(prompt, fullSystemPrompt, {
        response_format: {
          type: 'json_object',
        },
      });

      if (!response.success || !response.content) {
        logger.error('LLM 调用失败', { error: response.error });
        return null;
      }

      // 解析 JSON
      try {
        const parsed = JSON.parse(response.content);
        logger.debug('成功解析结构化输出', { contentLength: response.content.length });
        return this.validateResponse(parsed);
      } catch (parseError) {
        logger.error('JSON 解析失败，内容可能不是纯JSON格式', {
          error: parseError.message,
          contentPreview: response.content.substring(0, 200),
        });

        // 如果是纯JSON失败，尝试降级处理
        logger.info('尝试降级到手动解析模式');
        return await this.extractStructuredResponse(response.content);
      }
    } catch (error) {
      logger.error('结构化输出请求失败，降级到手动解析', undefined, error as Error);

      // 如果结构化输出失败，尝试手动解析
      try {
        return await this.requestWithManualParsing(prompt, systemPrompt);
      } catch (fallbackError) {
        logger.error('手动解析也失败', undefined, fallbackError as Error);
        return null;
      }
    }
  }

  /**
   * 降级方案：手动解析JSON
   * 从 LLM 响应中提取 JSON 对象
   */
  private async requestWithManualParsing(prompt: string, systemPrompt: string | undefined): Promise<StructuredLLMResponse | null> {
    try {
      const fullPrompt = `${prompt}\n\n只返回一个合法 JSON 对象，不要代码块，不要解释文字。`;

      const response = await this.llmManager.chatCompletion(fullPrompt, systemPrompt);

      if (!response.success || !response.content) {
        logger.error('LLM 调用失败', { error: response.error });
        return null;
      }

      // 使用栈解析提取所有JSON对象
      const parsed = this.extractStructuredResponse(response.content);

      if (parsed) {
        return this.validateResponse(parsed);
      }

      // 第一次解析失败 → 把错误原因回喂给模型，重试一次
      logger.warn('⚠️ 首次 JSON 解析失败，回喂错误信息重试', { preview: response.content.substring(0, 100) });
      const retryPrompt = `${fullPrompt}\n\n上一次你的输出无法被解析为合法 JSON，请重新输出，只返回 JSON 对象本身，不要任何其他内容。`;
      const retryResponse = await this.llmManager.chatCompletion(retryPrompt, systemPrompt);

      if (!retryResponse.success || !retryResponse.content) {
        logger.error('重试 LLM 调用失败', { error: retryResponse.error });
        return null;
      }

      const retryParsed = this.extractStructuredResponse(retryResponse.content);
      if (!retryParsed) {
        logger.warn('重试后仍无法提取有效结构化数据', { content: retryResponse.content.substring(0, 200) });
        return null;
      }

      return this.validateResponse(retryParsed);
    } catch (error) {
      logger.error('手动解析失败', undefined, error as Error);
      return null;
    }
  }

  /**
   * 从文本中提取结构化响应
   * 尝试找到完整的JSON对象
   */
  private extractStructuredResponse(text: string): StructuredLLMResponse | null {
    // 首先尝试直接解析整个文本
    try {
      const parsed = JSON.parse(text);
      if (this.isValidStructuredResponse(parsed)) {
        return parsed;
      }
    } catch {
      // 继续尝试其他方法
    }

    // 尝试找到被 ```json 包裹的内容
    const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        if (this.isValidStructuredResponse(parsed)) {
          return parsed;
        }
      } catch {
        // 继续尝试
      }
    }

    // 使用栈方法查找第一个完整的JSON对象
    const jsonObj = this.findFirstCompleteJson(text);
    if (jsonObj) {
      try {
        const parsed = JSON.parse(jsonObj);
        if (this.isValidStructuredResponse(parsed)) {
          return parsed;
        }
      } catch {
        // 最后的尝试也失败了
      }
    }

    // 降级：尝试提取thinking和actions数组
    return this.extractThinkingAndActions(text);
  }

  /**
   * 使用栈查找第一个完整的JSON对象
   */
  private findFirstCompleteJson(text: string): string | null {
    const stack: string[] = [];
    let start: number | null = null;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char === '{') {
        if (stack.length === 0) {
          start = i;
        }
        stack.push('{');
      } else if (char === '}') {
        if (stack.length > 0) {
          stack.pop();
          if (stack.length === 0 && start !== null) {
            return text.substring(start, i + 1);
          }
        }
      }
    }

    return null;
  }

  /**
   * 降级方案：从文本中提取thinking和动作
   *
   * 智能判断返回单动作还是多动作格式
   */
  private extractThinkingAndActions(text: string): StructuredLLMResponse | null {
    const actions: StructuredAction[] = [];

    // 提取thinking（如果有）
    let thinking: string | undefined;
    const thinkingMatch = text.match(/(?:思考|thinking)[：:]\s*(.+?)(?:\n|$)/i);
    if (thinkingMatch) {
      thinking = thinkingMatch[1].trim();
    }

    // 查找所有JSON对象
    const allJsons = this.findAllJsonObjects(text);

    for (const jsonStr of allJsons) {
      try {
        const obj = JSON.parse(jsonStr);
        if (obj.action_type) {
          actions.push(obj);
        }
      } catch {
        // 跳过无法解析的JSON
        logger.debug('跳过无效JSON', { json: jsonStr.substring(0, 100) });
      }
    }

    if (actions.length === 0) {
      return null;
    }

    // 根据上下文判断返回格式
    // 如果只有一个动作且上下文看起来像主决策，则返回单动作格式
    if (actions.length === 1 && this.looksLikeMainDecision(text)) {
      return { thinking, action: actions[0] };
    }

    // 否则返回多动作格式（箱子/熔炉操作）
    return { thinking, actions };
  }

  /**
   * 判断文本是否看起来像主决策模式
   */
  private looksLikeMainDecision(text: string): boolean {
    // 主决策通常不包含"箱子"、"熔炉"等关键词
    const containerKeywords = ['箱子', 'chest', '熔炉', 'furnace', 'container'];
    return !containerKeywords.some(keyword => text.toLowerCase().includes(keyword.toLowerCase()));
  }

  /**
   * 查找所有JSON对象
   */
  private findAllJsonObjects(text: string): string[] {
    const jsons: string[] = [];
    const stack: string[] = [];
    let start: number | null = null;
    let i = 0;

    while (i < text.length) {
      const char = text[i];

      if (char === '{') {
        if (stack.length === 0) {
          start = i;
        }
        stack.push('{');
      } else if (char === '}') {
        if (stack.length > 0) {
          stack.pop();
          if (stack.length === 0 && start !== null) {
            jsons.push(text.substring(start, i + 1));
            start = null;
          }
        }
      }

      i++;
    }

    return jsons;
  }

  /**
   * 检查是否是有效的结构化响应
   *
   * 统一单动作模式：检查单个action对象
   */
  private isValidStructuredResponse(obj: any): boolean {
    return obj && typeof obj === 'object' && obj.action && typeof obj.action === 'object';
  }

  /**
   * 验证响应格式
   *
   * 统一单动作模式：验证单个action对象
   */
  private validateResponse(response: any): StructuredLLMResponse | null {
    if (!response || typeof response !== 'object') {
      logger.warn('响应不是对象');
      return null;
    }

    // 验证单个action对象
    if (response.action && typeof response.action === 'object') {
      const action = response.action;
      if (!action.action_type) {
        logger.warn('动作缺少action_type字段', { action });
        return null;
      }
      return response as StructuredLLMResponse;
    }

    logger.warn('响应缺少action对象');
    return null;
  }

  /**
   * 使用结构化输出请求任务评估
   */
  private async requestTaskEvaluationWithStructuredOutput(prompt: string, systemPrompt: string | undefined): Promise<TaskEvaluationResponse | null> {
    try {
      const fullSystemPrompt = systemPrompt
        ? `${systemPrompt}\n\n你必须返回一个有效的JSON对象，包含task_status、progress_assessment和confidence字段。`
        : '你必须返回一个有效的JSON对象，包含task_status、progress_assessment和confidence字段。';

      logger.debug('调用LLM进行结构化任务评估');

      const response = await this.llmManager.chatCompletion(prompt, fullSystemPrompt, {
        response_format: {
          type: 'json_object',
        },
      });

      if (!response.success || !response.content) {
        logger.error('任务评估LLM调用失败', { error: response.error });
        return null;
      }

      logger.debug('LLM返回内容预览', {
        contentLength: response.content.length,
        contentPreview: response.content.substring(0, 200),
      });

      try {
        const parsed = JSON.parse(response.content);
        logger.debug('JSON解析成功，开始验证响应格式');
        const validated = this.validateTaskEvaluationResponse(parsed);
        if (validated) {
          logger.debug('任务评估响应验证通过', { status: validated.task_status });
        } else {
          logger.warn('任务评估响应验证失败');
        }
        return validated;
      } catch (parseError) {
        logger.error('任务评估JSON解析失败', {
          error: parseError.message,
          contentPreview: response.content.substring(0, 200),
        });
        return await this.extractTaskEvaluationResponse(response.content);
      }
    } catch (error) {
      logger.error('结构化任务评估请求失败', undefined, error as Error);
      return await this.requestTaskEvaluationWithManualParsing(prompt, systemPrompt);
    }
  }

  /**
   * 手动解析任务评估
   */
  private async requestTaskEvaluationWithManualParsing(prompt: string, systemPrompt: string | undefined): Promise<TaskEvaluationResponse | null> {
    try {
      const manualPrompt = `${prompt}\n\n请返回一个JSON对象，格式严格如下：
{
  "task_status": "on_track/struggling/blocked/needs_adjustment",
  "progress_assessment": "当前进度评估",
  "issues": ["问题1", "问题2"],
  "suggestions": ["建议1", "建议2"],
  "should_replan": false,
  "should_skip_task": false,
  "confidence": 0.0到1.0之间的数字
}

只返回JSON对象，不要有任何其他内容！`;

      logger.debug('使用手动解析模式调用LLM');

      const response = await this.llmManager.chatCompletion(manualPrompt, systemPrompt);

      if (!response.success || !response.content) {
        logger.error('任务评估手动解析LLM调用失败', { error: response.error });
        return null;
      }

      const parsed = this.extractTaskEvaluationResponse(response.content);

      if (!parsed) {
        logger.warn('无法从响应中提取任务评估', { content: response.content.substring(0, 200) });
        return null;
      }

      const validated = this.validateTaskEvaluationResponse(parsed);
      if (validated) {
        logger.debug('手动解析模式验证通过', { status: validated.task_status });
      } else {
        logger.warn('手动解析模式验证失败');
      }

      return validated;
    } catch (error) {
      logger.error('手动解析任务评估失败', undefined, error as Error);
      return null;
    }
  }

  /**
   * 从文本中提取任务评估响应
   */
  private extractTaskEvaluationResponse(text: string): TaskEvaluationResponse | null {
    logger.debug('开始手动提取任务评估响应');

    // 首先尝试直接解析整个文本
    try {
      const parsed = JSON.parse(text);
      if (this.isValidTaskEvaluationResponse(parsed)) {
        logger.debug('直接解析整个文本成功');
        return parsed;
      }
    } catch (error) {
      logger.debug('直接解析整个文本失败');
    }

    // 尝试找到被 ```json 包裹的内容
    const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        if (this.isValidTaskEvaluationResponse(parsed)) {
          logger.debug('解析```json代码块成功');
          return parsed;
        }
      } catch (error) {
        logger.debug('解析```json代码块失败');
      }
    }

    // 使用栈方法查找第一个完整的JSON对象
    const jsonObj = this.findFirstCompleteJson(text);
    if (jsonObj) {
      try {
        const parsed = JSON.parse(jsonObj);
        if (this.isValidTaskEvaluationResponse(parsed)) {
          logger.debug('使用栈方法找到并解析JSON成功');
          return parsed;
        }
      } catch (error) {
        logger.debug('栈方法找到的JSON解析失败');
      }
    }

    logger.warn('所有手动解析方法都失败了');
    return null;
  }

  /**
   * 检查是否是有效的任务评估响应
   */
  private isValidTaskEvaluationResponse(data: any): boolean {
    return this.validateTaskEvaluationResponse(data) !== null;
  }

  /**
   * 验证任务评估响应格式
   */
  private validateTaskEvaluationResponse(data: any): TaskEvaluationResponse | null {
    if (!data || typeof data !== 'object') {
      logger.warn('任务评估响应不是对象');
      return null;
    }

    // 验证必需字段
    if (!data.task_status || typeof data.task_status !== 'string') {
      logger.warn('任务评估响应缺少有效的task_status字段');
      return null;
    }

    const validStatuses = ['on_track', 'struggling', 'blocked', 'needs_adjustment'];
    if (!validStatuses.includes(data.task_status)) {
      logger.warn('任务评估响应的task_status值无效', { task_status: data.task_status });
      return null;
    }

    if (!data.progress_assessment || typeof data.progress_assessment !== 'string') {
      logger.warn('任务评估响应缺少有效的progress_assessment字段');
      return null;
    }

    if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) {
      logger.warn('任务评估响应的confidence字段无效');
      return null;
    }

    // 确保可选字段是正确的类型
    if (!data.issues) {
      data.issues = [];
    } else if (!Array.isArray(data.issues)) {
      data.issues = [];
    }

    if (!data.suggestions) {
      data.suggestions = [];
    } else if (!Array.isArray(data.suggestions)) {
      data.suggestions = [];
    }

    if (typeof data.should_replan !== 'boolean') {
      data.should_replan = false;
    }

    if (typeof data.should_skip_task !== 'boolean') {
      data.should_skip_task = false;
    }

    return data as TaskEvaluationResponse;
  }
}
