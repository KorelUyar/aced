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
const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("spurt", {
  platform: process.platform,
  name: arg("name"),
  sample: arg("sample") === "1",

  state: () => call("state"),
  recoverData: (how) => call("data:recover", how),
  revealData: () => call("data:reveal"),
  setSettings: (patch) => call("settings:set", patch),
  setKey: (provider, key) => call("ai:key", provider, key),
  testAi: () => call("ai:test"),
  claudeStatus: () => call("claude:status"),
  claudeSignIn: () => call("claude:signIn"),
  claudeSetup: () => call("claude:setup"),

  createExam: (draft) => call("exam:create", draft),
  editExam: (id, draft) => call("exam:edit", id, draft),
  deleteExam: (id) => call("exam:delete", id),

  chooseMaterial: (id) => call("material:choose", id),
  // A dropped file: the page only has a File object, its place on disk is found here. One file
  // at a time, because a list of files does not come through to this side in one piece.
  pathOf: (file) => webUtils.getPathForFile(file),
  addMaterial: (id, paths) => call("material:add", id, paths),
  addText: (id, kind, title, text) => call("material:text", id, kind, title, text),
  readText: (id, materialId) => call("material:read", id, materialId),
  changeText: (id, materialId, text) => call("material:retext", id, materialId, text),
  setMaterialKind: (id, materialId, kind) => call("material:kind", id, materialId, kind),
  removeMaterial: (id, materialId) => call("material:remove", id, materialId),
  restoreMaterial: (id, item) => call("material:restore", id, item),

  estimate: (id) => call("analysis:estimate", id),
  analyze: (id, options) => call("analysis:run", id, options),
  cancel: (id) => call("cancel", id),
  // What is running, for every exam: { [examId]: { kind, stage, title, done, total, startedAt } }.
  onRuns: on("runs"),
  // A choice from the app's menu: "settings" or "new".
  onMenu: on("menu"),

  formulas: (id) => call("formulas", id),
  help: (id, question, context) => call("help", id, question, context),
  taskDone: (id, taskId) => call("task:done", id, taskId),
  taskUndo: (id, taskId) => call("task:undo", id, taskId),
  openSet: (id, what) => call("set:open", id, what),
  saveDraft: (id, key, draft) => call("set:draft", id, key, draft),
  submitSet: (id, key, typed) => call("set:submit", id, key, typed),
  overrule: (id, key, questionId) => call("set:overrule", id, key, questionId),
  undoStrategy: (id) => call("strategy:undo", id),
});
