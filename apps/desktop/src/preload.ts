import { contextBridge, ipcRenderer } from "electron";

import type { NativeApi } from "@acme/contracts";

import { IPC_CHANNELS } from "./ipcChannels";

const nativeApi: NativeApi = {
  todos: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.todosList),
    add: (input) => ipcRenderer.invoke(IPC_CHANNELS.todosAdd, input),
    toggle: (id) => ipcRenderer.invoke(IPC_CHANNELS.todosToggle, id),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.todosRemove, id)
  }
};

contextBridge.exposeInMainWorld("nativeApi", nativeApi);
