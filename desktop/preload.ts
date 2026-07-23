import { contextBridge, ipcRenderer } from "electron";
import { CHOOSE_DIRECTORY_CHANNEL } from "./channels.ts";

contextBridge.exposeInMainWorld("aldunisDesktop", {
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke(CHOOSE_DIRECTORY_CHANNEL),
});
