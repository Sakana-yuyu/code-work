import { fixPath } from "./fixPath";
fixPath();

import path from "node:path";
import { BrowserWindow, app, ipcMain, session } from "electron";

import {
  IPC_CHANNELS,
  agentConfigSchema,
  agentSessionIdSchema,
  newTodoInputSchema,
  todoIdSchema,
} from "@acme/contracts";
import { ProcessManager } from "./processManager";
import { TodoStore } from "./todoStore";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

let todoStore: TodoStore;
const processManager = new ProcessManager();

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  window.once("ready-to-show", () => {
    window.show();
  });

  setupEventForwarding(window);

  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    return window;
  }

  void window.loadFile(path.join(__dirname, "../../renderer/dist/index.html"));
  return window;
}

function registerIpcHandlers(): void {
  // Todo handlers
  ipcMain.handle(IPC_CHANNELS.todosList, async () => {
    return todoStore.list();
  });

  ipcMain.handle(IPC_CHANNELS.todosAdd, async (_event, payload: unknown) => {
    return todoStore.add(newTodoInputSchema.parse(payload));
  });

  ipcMain.handle(IPC_CHANNELS.todosToggle, async (_event, id: unknown) => {
    return todoStore.toggle(todoIdSchema.parse(id));
  });

  ipcMain.handle(IPC_CHANNELS.todosRemove, async (_event, id: unknown) => {
    return todoStore.remove(todoIdSchema.parse(id));
  });

  // Agent handlers
  ipcMain.handle(IPC_CHANNELS.agentSpawn, async (_event, config: unknown) => {
    return processManager.spawn(agentConfigSchema.parse(config));
  });

  ipcMain.handle(IPC_CHANNELS.agentKill, async (_event, sessionId: unknown) => {
    processManager.kill(agentSessionIdSchema.parse(sessionId));
  });

  ipcMain.handle(
    IPC_CHANNELS.agentWrite,
    async (_event, sessionId: unknown, data: unknown) => {
      processManager.write(agentSessionIdSchema.parse(sessionId), String(data));
    },
  );
}

function setupEventForwarding(window: BrowserWindow): void {
  const onOutput = (chunk: unknown) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.agentOutput, chunk);
    }
  };

  const onExit = (exit: unknown) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.agentExit, exit);
    }
  };

  processManager.on("output", onOutput);
  processManager.on("exit", onExit);

  window.on("closed", () => {
    processManager.off("output", onOutput);
    processManager.off("exit", onExit);
  });
}

function setupCSP(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDevelopment
      ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

async function bootstrap(): Promise<void> {
  setupCSP();

  todoStore = new TodoStore(path.join(app.getPath("userData"), "todos.json"));
  await todoStore.init();

  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

app.on("before-quit", () => {
  processManager.killAll();
});

app.whenReady().then(() => {
  void bootstrap();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
