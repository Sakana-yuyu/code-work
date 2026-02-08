import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { Todo } from "@acme/contracts";

function formatCreatedAt(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

function readNativeApi() {
  if (typeof window === "undefined") {
    return undefined;
  }

  return window.nativeApi;
}

export default function App() {
  const api = useMemo(() => readNativeApi(), []);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTodos = useCallback(async () => {
    if (!api) {
      return;
    }

    setError(null);

    try {
      const nextTodos = await api.todos.list();
      setTodos(nextTodos);
    } catch (loadError) {
      const message =
        loadError instanceof Error
          ? loadError.message
          : "Could not fetch todos.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!api) {
      return;
    }

    const trimmed = title.trim();
    if (!trimmed) {
      return;
    }

    setError(null);

    try {
      const nextTodos = await api.todos.add({ title: trimmed });
      setTodos(nextTodos);
      setTitle("");
    } catch (addError) {
      const message =
        addError instanceof Error ? addError.message : "Could not add todo.";
      setError(message);
    }
  };

  const onToggle = async (id: string) => {
    if (!api) {
      return;
    }

    setError(null);

    try {
      const nextTodos = await api.todos.toggle(id);
      setTodos(nextTodos);
    } catch (toggleError) {
      const message =
        toggleError instanceof Error
          ? toggleError.message
          : "Could not toggle todo.";
      setError(message);
    }
  };

  const onRemove = async (id: string) => {
    if (!api) {
      return;
    }

    setError(null);

    try {
      const nextTodos = await api.todos.remove(id);
      setTodos(nextTodos);
    } catch (removeError) {
      const message =
        removeError instanceof Error
          ? removeError.message
          : "Could not remove todo.";
      setError(message);
    }
  };

  if (!api) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center px-8">
        <section className="rounded-3xl border border-amber-200 bg-amber-50 px-6 py-5 text-amber-900 shadow-soft">
          <h1 className="text-lg font-semibold">Native bridge unavailable</h1>
          <p className="mt-2 text-sm">
            Launch this UI through Electron so the preload API is available.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6 py-12 text-slate-900 sm:px-10">
      <header className="rounded-3xl border border-slate-200/80 bg-white/80 p-7 shadow-soft backdrop-blur">
        <h1 className="text-3xl font-semibold tracking-tight">
          Long-Horizon TODOs
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Renderer is isolated. All native access is routed through a typed
          preload API.
        </p>

        <form className="mt-6 flex gap-3" onSubmit={onSubmit}>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Write a task..."
            className="h-11 flex-1 rounded-xl border border-slate-300 bg-white px-4 text-sm outline-none ring-0 transition focus:border-slate-500"
            maxLength={280}
          />
          <button
            type="submit"
            className="h-11 rounded-xl bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            Add
          </button>
        </form>
      </header>

      <section className="mt-6 rounded-3xl border border-slate-200/70 bg-white/80 p-4 shadow-soft backdrop-blur sm:p-6">
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading todos...</p>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        ) : null}

        {!isLoading && todos.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
            No todos yet. Add one above.
          </p>
        ) : null}

        <ul className="space-y-3">
          {todos.map((todo) => (
            <li
              key={todo.id}
              className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3"
            >
              <button
                type="button"
                onClick={() => {
                  void onToggle(todo.id);
                }}
                className="flex flex-1 items-center gap-3 text-left"
              >
                <span
                  className={[
                    "mt-0.5 inline-block h-5 w-5 rounded-full border transition",
                    todo.completed
                      ? "border-emerald-600 bg-emerald-500"
                      : "border-slate-300 bg-white",
                  ].join(" ")}
                />
                <span>
                  <p
                    className={[
                      "text-sm font-medium",
                      todo.completed
                        ? "text-slate-400 line-through"
                        : "text-slate-800",
                    ].join(" ")}
                  >
                    {todo.title}
                  </p>
                  <p className="text-xs text-slate-500">
                    Created {formatCreatedAt(todo.createdAt)}
                  </p>
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  void onRemove(todo.id);
                }}
                className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
