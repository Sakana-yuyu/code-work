import { z } from "zod";

export const todoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(280),
  completed: z.boolean(),
  createdAt: z.string().datetime()
});

export const todoListSchema = z.array(todoSchema);

export const newTodoInputSchema = z.object({
  title: z.string().trim().min(1).max(280)
});

export const todoIdSchema = z.string().min(1);

export type Todo = z.infer<typeof todoSchema>;
export type NewTodoInput = z.infer<typeof newTodoInputSchema>;
