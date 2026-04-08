/**
 * 主思考模板
 */

import { PromptTemplate, promptManager } from '@/core/agent/prompt/prompt_manager';

export function initMainThinkingTemplate(): void {
  promptManager.registerTemplate(
    new PromptTemplate(
      'main_thinking',
      `{basic_info}

{failed_hint}

# 上一阶段反思
{judge_guidance}

# 近期思考和执行记录
{thinking_list}

从上方候选动作中选择一个，只返回 JSON，不要解释。`,
      '任务-动作选择',
      ['basic_info', 'failed_hint', 'judge_guidance', 'thinking_list'],
    ),
  );
}
