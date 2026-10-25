import { MessageId, ProviderInstanceId, ThreadId } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("摘要时间在空线程或只有 assistant 时为 null，并隔离线程", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("summary-empty");
      assert.equal(yield* repository.getLatestUserMessageAt({ threadId }), null);
      yield* repository.upsert({
        messageId: MessageId.make("summary-assistant"),
        threadId,
        turnId: null,
        role: "assistant",
        text: "较新的长正文".repeat(10_000),
        isStreaming: false,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      yield* repository.upsert({
        messageId: MessageId.make("summary-other-user"),
        threadId: ThreadId.make("summary-other"),
        turnId: null,
        role: "user",
        text: "其他线程",
        isStreaming: false,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      assert.equal(yield* repository.getLatestUserMessageAt({ threadId }), null);
      assert.equal(
        yield* repository.getLatestUserMessageAt({ threadId: ThreadId.make("summary-other") }),
        "2026-03-01T00:00:00.000Z",
      );
    }),
  );

  it.effect("摘要按用户 createdAt 最大值处理迟到消息，不受更新时间和序号影响", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("summary-order");
      for (const [index, createdAt] of [
        "2026-03-01T00:00:02.000Z",
        "2026-03-01T00:00:01.000Z",
        "2026-03-01T00:00:03.000Z",
      ].entries()) {
        yield* repository.upsert({
          messageId: MessageId.make(`summary-user-${index}`),
          threadId,
          turnId: null,
          role: "user",
          text: "历史正文".repeat(1_000),
          isStreaming: false,
          createdAt,
          updatedAt: "2026-03-02T00:00:00.000Z",
          firstSequence: 100 - index,
        });
      }
      assert.equal(
        yield* repository.getLatestUserMessageAt({ threadId }),
        "2026-03-01T00:00:03.000Z",
      );
    }),
  );

  it.effect("覆盖用户消息角色与删除后摘要即时更新", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const input = {
        messageId: MessageId.make("summary-replace"),
        threadId: ThreadId.make("summary-replace"),
        turnId: null,
        role: "user" as const,
        text: "用户",
        isStreaming: false,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      };
      yield* repository.upsert(input);
      assert.equal(yield* repository.getLatestUserMessageAt(input), input.createdAt);
      yield* repository.upsert({ ...input, role: "assistant", text: "替换为 assistant" });
      assert.equal(yield* repository.getLatestUserMessageAt(input), null);
      yield* repository.upsert(input);
      yield* repository.deleteByThreadId(input);
      assert.equal(yield* repository.getLatestUserMessageAt(input), null);
    }),
  );

  it.effect("流式消息原子追加并保留首次位置、附件与来源", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const initial = {
        messageId: MessageId.make("message-atomic-stream"),
        threadId: ThreadId.make("thread-atomic-stream"),
        turnId: null,
        role: "assistant" as const,
        firstSequence: 10,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        text: "中文与😀\n",
        attachments: [
          {
            type: "image" as const,
            id: "atomic-att",
            name: "图.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: true,
        createdAt: "2026-02-28T19:00:00.000Z",
        updatedAt: "2026-02-28T19:00:00.000Z",
      };
      yield* repository.applyMessage(initial);
      const { attachments: _attachments, providerInstanceId: _provider, ...delta } = initial;
      yield* repository.applyMessage({
        ...delta,
        firstSequence: 11,
        text: "尾段",
        createdAt: "2026-02-28T19:00:01.000Z",
        updatedAt: "2026-02-28T19:00:01.000Z",
      });
      const rows = yield* repository.listByThreadId({ threadId: initial.threadId });
      assert.deepEqual(rows, [
        { ...initial, text: "中文与😀\n尾段", updatedAt: "2026-02-28T19:00:01.000Z" },
      ]);
    }),
  );

  for (const completion of ["", "完整替换😀"] as const) {
    it.effect(`完成消息${completion === "" ? "保留已积累文本" : "以明确正文替换"}`, () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadMessageRepository;
        const message = {
          messageId: MessageId.make(`message-complete-${completion.length}`),
          threadId: ThreadId.make(`thread-complete-${completion.length}`),
          turnId: null,
          role: "assistant" as const,
          text: "流式内容",
          isStreaming: true,
          createdAt: "2026-02-28T19:00:00.000Z",
          updatedAt: "2026-02-28T19:00:00.000Z",
        };
        yield* repository.applyMessage(message);
        yield* repository.applyMessage({ ...message, text: completion, isStreaming: false });
        const rows = yield* repository.listByThreadId({ threadId: message.threadId });
        assert.deepEqual(rows, [
          { ...message, text: completion || message.text, isStreaming: false },
        ]);
      }),
    );
  }

  it.effect("消息事件允许清空附件与更换来源，普通 upsert 保持替换语义", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const message = {
        messageId: MessageId.make("message-apply-options"),
        threadId: ThreadId.make("thread-apply-options"),
        turnId: null,
        role: "assistant" as const,
        text: "首次",
        isStreaming: true,
        providerInstanceId: ProviderInstanceId.make("codex"),
        attachments: [
          {
            type: "image" as const,
            id: "options-att",
            name: "a.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        createdAt: "2026-02-28T19:00:00.000Z",
        updatedAt: "2026-02-28T19:00:00.000Z",
      };
      yield* repository.upsert(message);
      yield* repository.applyMessage({
        ...message,
        text: "追加",
        attachments: [],
        firstSequence: 3,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      let rows = yield* repository.listByThreadId({ threadId: message.threadId });
      assert.deepEqual(rows, [
        {
          ...message,
          text: "首次追加",
          attachments: [],
          firstSequence: 3,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        },
      ]);
      yield* repository.upsert({
        ...message,
        text: "",
        attachments: [],
        createdAt: "2026-02-28T19:00:02.000Z",
      });
      rows = yield* repository.listByThreadId({ threadId: message.threadId });
      assert.equal(rows[0]?.text, "");
      assert.equal(rows[0]?.createdAt, "2026-02-28T19:00:02.000Z");
      assert.equal(rows[0]?.firstSequence, 3);
    }),
  );

  it.effect("并发追加保留每个片段，不丢失累积正文", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const message = {
        messageId: MessageId.make("message-concurrent-append"),
        threadId: ThreadId.make("thread-concurrent-append"),
        turnId: null,
        role: "assistant" as const,
        text: "",
        isStreaming: true,
        createdAt: "2026-02-28T19:00:00.000Z",
        updatedAt: "2026-02-28T19:00:00.000Z",
      };
      yield* repository.applyMessage(message);
      const chunks = Array.from({ length: 30 }, (_, index) => `[${index}]`);
      yield* Effect.forEach(chunks, (text) => repository.applyMessage({ ...message, text }), {
        concurrency: "unbounded",
      });
      const rows = yield* repository.listByThreadId({ threadId: message.threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text.length, chunks.join("").length);
      for (const chunk of chunks) assert.equal(rows[0]?.text.split(chunk).length, 2);
    }),
  );

  it.effect("投影事务失败回滚消息追加，原正文与流式状态保持完整", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const sql = yield* SqlClient.SqlClient;
      const message = {
        messageId: MessageId.make("message-append-rollback"),
        threadId: ThreadId.make("thread-append-rollback"),
        turnId: null,
        role: "assistant" as const,
        text: "原正文",
        isStreaming: true,
        createdAt: "2026-02-28T19:00:00.000Z",
        updatedAt: "2026-02-28T19:00:00.000Z",
      };
      yield* repository.applyMessage(message);
      const result = yield* Effect.result(
        sql.withTransaction(
          repository
            .applyMessage({ ...message, text: "不应提交", isStreaming: false })
            .pipe(Effect.andThen(Effect.fail("回滚"))),
        ),
      );
      assert.equal(result._tag, "Failure");
      const rows = yield* repository.listByThreadId({ threadId: message.threadId });
      assert.deepEqual(rows, [message]);
    }),
  );

  it.effect("相同时间戳按首次事件顺序读取，后续流式更新不改变位置", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-message-order");
      const createdAt = "2026-02-28T19:00:00.000Z";
      for (const [messageId, firstSequence] of [
        ["z-user", 12],
        ["a-assistant", 13],
      ] as const) {
        yield* repository.upsert({
          messageId: MessageId.make(messageId),
          threadId,
          turnId: null,
          role: messageId === "z-user" ? "user" : "assistant",
          firstSequence,
          text: messageId,
          isStreaming: false,
          createdAt,
          updatedAt: createdAt,
        });
      }
      yield* repository.upsert({
        messageId: MessageId.make("a-assistant"),
        threadId,
        turnId: null,
        role: "assistant",
        firstSequence: 14,
        text: "completed",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      const messages = yield* repository.listByThreadId({ threadId });
      assert.deepEqual(
        messages.map((message) => [String(message.messageId), message.firstSequence]),
        [
          ["z-user", 12],
          ["a-assistant", 13],
        ],
      );
      assert.equal(messages[1]?.text, "completed");
    }),
  );

  it.effect("keeps the assistant's provider instance after later message updates", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-provider-attribution");
      const messageId = MessageId.make("message-provider-attribution");
      const createdAt = "2026-02-28T19:00:00.000Z";
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        text: "first",
        isStreaming: true,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "final",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows[0]?.providerInstanceId, "claudeAgent");
      assert.equal(rows[0]?.text, "final");
    }),
  );

  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );
});
