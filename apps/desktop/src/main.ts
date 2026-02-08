import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";

import { newTodoInputSchema, todoIdSchema } from "@acme/contracts";

import { IPC_CHANNELS } from "./ipcChannels";
import { TodoStore } from "./todoStore";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

let todoStore: TodoStore;

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
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  window.once("ready-to-show", () => {
    window.show();
  });

  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    return window;
  }

  void window.loadFile(path.join(__dirname, "../../renderer/dist/index.html"));
  return window;
}

function registerIpcHandlers(): void {
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
}

async function bootstrap(): Promise<void> {
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

app.whenReady().then(() => {
  void bootstrap();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
