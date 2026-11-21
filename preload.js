const { contextBridge, ipcRenderer } = require("electron");

const arg = (key) => (process.argv.find((a) => a.startsWith(`--spurt-${key}=`)) || "").split("=")[1];

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld("spurt", {
  platform: process.platform,
  name: arg("name"),
  sample: arg("sample") === "1",
  state: () => call("state"),
  createExam: (draft) => call("exam:create", draft),
  updateExam: (id, patch) => call("exam:update", id, patch),
  setSettings: (patch) => call("settings:set", patch),
});
