import type { NewTodoInput, Todo } from "./todo";

export const IPC_CHANNELS = {
  todosList: "todos:list",
  todosAdd: "todos:add",
  todosToggle: "todos:toggle",
  todosRemove: "todos:remove"
} as const;

export interface NativeApi {
  todos: {
    list: () => Promise<Todo[]>;
    add: (input: NewTodoInput) => Promise<Todo[]>;
    toggle: (id: string) => Promise<Todo[]>;
    remove: (id: string) => Promise<Todo[]>;
  };
}
