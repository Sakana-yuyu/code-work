// 历史与重放游标可跨页面切换保留；实时订阅只由仍挂载的消费者持有。
export const THREAD_STATE_IDLE_TTL_MS = 5 * 60_000;
