import * as Schema from "effect/Schema";

/**
 * 草稿会话的稳定标识。该基础类型不能依赖完整的草稿存储，供启动期工具函数使用。
 */
export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;
