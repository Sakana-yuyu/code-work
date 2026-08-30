import * as Schema from "effect/Schema";

export class CompositionTaskNotFoundError extends Schema.TaggedErrorClass<CompositionTaskNotFoundError>()(
  "CompositionTaskNotFoundError",
  {
    taskId: Schema.String,
    runId: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId} 或运行 ${this.runId} 不存在。`;
  }
}

export class CompositionTaskRetryInvalidError extends Schema.TaggedErrorClass<CompositionTaskRetryInvalidError>()(
  "CompositionTaskRetryInvalidError",
  {
    taskId: Schema.String,
    previousRunId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId}/${this.previousRunId} 不允许重试：${this.reason}`;
  }
}

export class CompositionAgentDriverFailure extends Schema.TaggedErrorClass<CompositionAgentDriverFailure>()(
  "CompositionAgentDriverFailure",
  {
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Agent Driver 启动失败：${this.code}: ${this.detail}`;
  }
}
