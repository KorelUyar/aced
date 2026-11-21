const { contextBridge, ipcRenderer, webUtils } = require("electron");

const arg = (key) => (process.argv.find((a) => a.startsWith(`--spurt-${key}=`)) || "").split("=")[1];

// Every call resolves to its value, or throws an Error the interface has a sentence for.
// Only an Error's message survives the way from here into the page, so the code and the
// detail travel in the message: "code" or "code\ndetail" (ui/i18n.js takes it apart again).
const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.detail ? `${r.error}\n${r.detail}` : r.error);
  return r.value;
};

contextBridge.exposeInMainWorld("spurt", {
  platform: process.platform,
  name: arg("name"),
  sample: arg("sample") === "1",

  state: () => call("state"),
  setSettings: (patch) => call("settings:set", patch),
  setKey: (provider, key) => call("ai:key", provider, key),
  testAi: () => call("ai:test"),

  createExam: (draft) => call("exam:create", draft),
  editExam: (id, draft) => call("exam:edit", id, draft),
  deleteExam: (id) => call("exam:delete", id),

  chooseMaterial: (id) => call("material:choose", id),
  // Dropped files: the page only sees File objects; their paths are resolved here.
  addMaterial: (id, fileList) => call("material:add", id, [...fileList].map((f) => webUtils.getPathForFile(f))),
  addText: (id, kind, title, text) => call("material:text", id, kind, title, text),
  setMaterialKind: (id, materialId, kind) => call("material:kind", id, materialId, kind),
  removeMaterial: (id, materialId) => call("material:remove", id, materialId),
  openBook: (id, materialId, page) => call("book:open", id, materialId, page),

  estimate: (id) => call("analysis:estimate", id),
  analyze: (id) => call("analysis:run", id),
  cancel: () => call("cancel"),
  onProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on("progress", listener);
    return () => ipcRenderer.removeListener("progress", listener);
  },

  taskDone: (id, taskId) => call("task:done", id, taskId),
  doMore: (id) => call("task:more", id),
  openQuiz: (id, what) => call("quiz:open", id, what),
  answer: (sessionId, questionId, answer) => call("quiz:answer", sessionId, questionId, answer),
  finishQuiz: (sessionId) => call("quiz:finish", sessionId),
});
