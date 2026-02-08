import { describe, expect, it } from "vitest";

import { newTodoInputSchema, todoSchema } from "./todo";

describe("todoSchema", () => {
  it("accepts a valid todo", () => {
    const result = todoSchema.safeParse({
      id: "abc-123",
      title: "Buy milk",
      completed: false,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a todo with empty id", () => {
    const result = todoSchema.safeParse({
      id: "",
      title: "Buy milk",
      completed: false,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a todo with empty title", () => {
    const result = todoSchema.safeParse({
      id: "abc-123",
      title: "",
      completed: false,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("newTodoInputSchema", () => {
  it("accepts valid input", () => {
    const result = newTodoInputSchema.safeParse({ title: "Buy milk" });
    expect(result.success).toBe(true);
  });

  it("trims whitespace", () => {
    const result = newTodoInputSchema.parse({ title: "  Buy milk  " });
    expect(result.title).toBe("Buy milk");
  });

  it("rejects empty title after trimming", () => {
    const result = newTodoInputSchema.safeParse({ title: "   " });
    expect(result.success).toBe(false);
  });
});
