/**
 * OpenAI LLM提供商实现
 *
 * 实现对OpenAI API的调用，包括token计数、重试机制等
 */

import { OpenAI as OpenAIClient } from 'openai';
import { encoding_for_model, get_encoding } from 'tiktoken';
import { Logger } from '@/utils/Logger';
import {
  LLMProvider,
  LLMResponse,
  LLMRequestConfig,
  ChatMessage,
  LLMError,
  LLMProvider as ProviderType,
  TokenUsage,
  ValidatedLLMRequestConfig,
} from '@/llm/types';
import { OpenAIConfig, RetryConfig } from '@/llm/types';
import { z } from 'zod';

/**
 * OpenAI提供商实现
 */
export class OpenAIProvider implements ILLMProvider {
  public readonly provider = ProviderType.OPENAI;
  private client: OpenAIClient;
  private logger: Logger;
  private config: OpenAIConfig;
  private retryConfig: RetryConfig;

  constructor(config: OpenAIConfig, retryConfig: RetryConfig, logger?: Logger) {
    this.config = config;
    this.retryConfig = retryConfig;
    this.logger =
      logger ||
      new Logger({
        level: (globalThis as any).logLevel || 2, // INFO
        console: true,
        file: false,
      }).child('OpenAIProvider');

    // 初始化OpenAI客户端
    this.client = new OpenAIClient({
      apiKey: config.api_key,
      baseURL: config.base_url,
    });

    this.logger.info('OpenAI提供商初始化完成', {
      model: config.model,
      base_url: config.base_url,
    });
  }

  /**
   * 发送聊天请求
   */
  async chat(requestConfig: LLMRequestConfig): Promise<LLMResponse> {
    // 验证请求配置
    const validatedConfig = this.validateRequestConfig(requestConfig);

    // 检查API密钥
    if (!this.config.api_key) {
      throw new LLMError('OpenAI API key is required', 'API_KEY_MISSING', ProviderType.OPENAI);
    }

    this.logger.debug('发送OpenAI聊天请求', {
      model: validatedConfig.model,
      message_count: validatedConfig.messages.length,
      max_tokens: validatedConfig.max_tokens,
    });

    return this.withRetry(async () => {
      try {
        // 发送请求
        const completion = await this.client.chat.completions.create({
          model: validatedConfig.model,
          messages: validatedConfig.messages.map(msg => ({
            role: msg.role as 'system' | 'user' | 'assistant',
            content: msg.content,
            name: msg.name,
          })),
          max_tokens: validatedConfig.max_tokens,
          temperature: validatedConfig.temperature,
          top_p: validatedConfig.top_p,
          frequency_penalty: validatedConfig.frequency_penalty,
          presence_penalty: validatedConfig.presence_penalty,
          stop: validatedConfig.stop,
          stream: false, // 暂时不支持流式
        });

        // 转换响应格式
        const response: LLMResponse = {
          id: completion.id,
          object: completion.object,
          created: completion.created,
          model: completion.model,
          choices: completion.choices.map((choice: any) => ({
            index: choice.index,
            message: {
              role: choice.message.role as any,
              content: choice.message.content || '',
            },
            finish_reason: choice.finish_reason || 'stop',
            logprobs: choice.logprobs as any,
          })),
          usage: completion.usage!,
          provider: ProviderType.OPENAI,
        };

        // 如果API没有返回使用统计，才计算token数（兼容性处理）
        if (!completion.usage) {
          this.logger.warn('API未返回token使用统计，使用tiktoken估算', { model: completion.model });
          const promptTokens = this.countTokens(validatedConfig.messages as ChatMessage[]);
          const completionTokens = this.countTokens([response.choices[0].message]);
          response.usage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          };
        }

        this.logger.debug('OpenAI请求成功', {
          response_id: response.id,
          usage: response.usage,
        });

        return response;
      } catch (error: any) {
        if (error.status) {
          // OpenAI API错误
          throw this.handleOpenAIError(error);
        } else {
          // 其他错误
          throw new LLMError(
            `OpenAI API request failed: ${error.message}`,
            'REQUEST_FAILED',
            ProviderType.OPENAI,
            error.status,
            this.isRetryableError(error),
          );
        }
      }
    });
  }

  /**
   * 流式聊天（当前不支持）
   */
  async *streamChat(requestConfig: LLMRequestConfig): AsyncGenerator<LLMResponse, void, unknown> {
    throw new LLMError('Stream chat not implemented for OpenAI provider', 'NOT_IMPLEMENTED', ProviderType.OPENAI);
  }

  /**
   * 获取支持的模型列表
   */
  async getModels(): Promise<string[]> {
    try {
      const models = await this.client.models.list();
      return models.data.map(model => model.id);
    } catch (error: any) {
      this.logger.error('获取OpenAI模型列表失败', {
        error: error.message,
      });
      return [];
    }
  }

  /**
   * 计算token数量
   */
  countTokens(messages: ChatMessage[]): number {
    let encoding;

    // 对于非OpenAI官方API（如阿里云DashScope），直接使用通用编码
    const isOfficialOpenAI =
      this.config.base_url?.includes('openai.com') || !this.config.base_url || this.config.base_url === 'https://api.openai.com/v1';

    if (!isOfficialOpenAI) {
      this.logger.debug('使用第三方API，直接使用通用编码', {
        base_url: this.config.base_url,
        model: this.config.model,
      });

      try {
        encoding = get_encoding('cl100k_base');
      } catch (error) {
        this.logger.warn('通用编码获取失败，使用字符估算方法', {
          error: error instanceof Error ? error.message : String(error),
          model: this.config.model,
        });

        // 如果tiktoken完全失败，使用改进的字符数估算
        let totalChars = 0;
        for (const message of messages) {
          totalChars += message.content.length;
          if (message.name) {
            totalChars += message.name.length;
          }
        }
        // 使用更准确的估算：英文约为0.25个token/字符，中文约为0.5个token/字符
        // 这里使用平均值0.35作为折中
        return Math.ceil(totalChars * 0.35);
      }
    } else {
      try {
        // 对于OpenAI官方API，尝试使用模型特定的编码
        encoding = encoding_for_model(this.config.model as any);
      } catch (error) {
        this.logger.debug('模型特定编码不可用，使用通用编码', {
          error: error instanceof Error ? error.message : String(error),
          model: this.config.model,
        });

        try {
          // 对于未知模型，使用cl100k_base编码（GPT-3.5/4使用的编码）
          encoding = get_encoding('cl100k_base');
        } catch (fallbackError) {
          this.logger.warn('tiktoken编码获取失败，使用字符估算方法', {
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            model: this.config.model,
          });

          // 如果tiktoken完全失败，使用改进的字符数估算
          let totalChars = 0;
          for (const message of messages) {
            totalChars += message.content.length;
            if (message.name) {
              totalChars += message.name.length;
            }
          }
          // 使用更准确的估算：英文约为0.25个token/字符，中文约为0.5个token/字符
          // 这里使用平均值0.35作为折中
          return Math.ceil(totalChars * 0.35);
        }
      }
    }

    try {
      // 计算每条消息的token数
      let totalTokens = 0;

      for (const message of messages) {
        // 计算每条消息的token数
        const tokensPerMessage = 4; // 每条消息的固定token开销
        const tokens = encoding.encode(message.content);

        totalTokens += tokensPerMessage + tokens.length;

        // 如果有name字段，添加其token数
        if (message.name) {
          const nameTokens = encoding.encode(message.name);
          totalTokens += nameTokens.length;
        }
      }

      // 添加回复的固定token开销
      totalTokens += 3; // 每次回复的固定token开销

      return totalTokens;
    } finally {
      // 确保编码器被释放
      encoding.free();
    }
  }

  /**
   * 验证请求配置
   */
  private validateRequestConfig(config: LLMRequestConfig): ValidatedLLMRequestConfig {
    // 合并默认配置
    const mergedConfig = {
      model: config.model || this.config.model,
      messages: config.messages,
      max_tokens: config.max_tokens || this.config.max_tokens,
      temperature: config.temperature ?? this.config.temperature,
      top_p: config.top_p,
      frequency_penalty: config.frequency_penalty,
      presence_penalty: config.presence_penalty,
      stop: config.stop,
      stream: config.stream ?? false,
    };

    // 验证配置
    return this.validateWithSchema(mergedConfig);
  }

  /**
   * 使用Schema验证配置
   */
  private validateWithSchema(config: any): ValidatedLLMRequestConfig {
    const schema = z.object({
      model: z.string().min(1),
      messages: z
        .array(
          z.object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().min(1),
            name: z.string().optional(),
          }),
        )
        .min(1),
      max_tokens: z.number().int().positive().max(128000).optional(),
      temperature: z.number().min(0).max(2).optional(),
      top_p: z.number().min(0).max(1).optional(),
      frequency_penalty: z.number().min(-2).max(2).optional(),
      presence_penalty: z.number().min(-2).max(2).optional(),
      stop: z.union([z.string(), z.array(z.string())]).optional(),
      stream: z.boolean(),
    });

    return schema.parse(config);
  }

  /**
   * 带重试的请求执行
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.retryConfig.max_attempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        // 如果是最后一次尝试，直接抛出错误
        if (attempt === this.retryConfig.max_attempts) {
          throw error;
        }

        // 检查是否可重试
        if (error instanceof LLMError && !error.retryable) {
          throw error;
        }

        // 计算延迟时间
        const delay = this.calculateDelay(attempt);

        this.logger.warn('OpenAI请求失败，准备重试', {
          attempt,
          max_attempts: this.retryConfig.max_attempts,
          delay,
          error: error instanceof Error ? error.message : String(error),
        });

        // 等待延迟时间
        await this.sleep(delay);
      }
    }

    throw lastError!;
  }

  /**
   * 计算重试延迟
   */
  private calculateDelay(attempt: number): number {
    const baseDelay = this.retryConfig.initial_delay;
    const multiplier = Math.pow(this.retryConfig.backoff_multiplier, attempt - 1);
    const delay = Math.min(baseDelay * multiplier, this.retryConfig.max_delay);

    // 添加随机抖动，避免多个客户端同时重试
    const jitter = delay * 0.1 * Math.random();

    return Math.floor(delay + jitter);
  }

  /**
   * 处理OpenAI API错误
   */
  private handleOpenAIError(error: any): LLMError {
    const { status, code, message } = error;

    let errorType = 'UNKNOWN_ERROR';
    let retryable = false;

    switch (status) {
      case 400:
        errorType = 'BAD_REQUEST';
        retryable = false;
        break;
      case 401:
        errorType = 'UNAUTHORIZED';
        retryable = false;
        break;
      case 403:
        errorType = 'FORBIDDEN';
        retryable = false;
        break;
      case 404:
        errorType = 'NOT_FOUND';
        retryable = false;
        break;
      case 413:
        errorType = 'PAYLOAD_TOO_LARGE';
        retryable = false;
        break;
      case 429:
        errorType = 'RATE_LIMITED';
        retryable = true;
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        errorType = 'SERVER_ERROR';
        retryable = true;
        break;
    }

    // 根据错误代码进一步判断
    if (code) {
      switch (code) {
        case 'rate_limit_exceeded':
        case 'insufficient_quota':
          errorType = code.toUpperCase();
          retryable = true;
          break;
        case 'context_length_exceeded':
          errorType = code.toUpperCase();
          retryable = false;
          break;
      }
    }

    return new LLMError(`OpenAI API error: ${message}`, errorType, ProviderType.OPENAI, status, retryable);
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryableError(error: any): boolean {
    // 网络错误通常可以重试
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true;
    }

    // 超时错误可以重试
    if (error.code === 'TIMEOUT') {
      return true;
    }

    return false;
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 关闭提供商
   */
  close(): void {
    this.logger.info('关闭OpenAI提供商');
  }
}

/**
 * LLM提供商接口
 */
export interface ILLMProvider {
  readonly provider: ProviderType;
  chat(requestConfig: LLMRequestConfig): Promise<LLMResponse>;
  streamChat?(requestConfig: LLMRequestConfig): AsyncGenerator<LLMResponse, void, unknown>;
  getModels(): Promise<string[]>;
  countTokens(messages: ChatMessage[]): number;
  close(): void;
}
