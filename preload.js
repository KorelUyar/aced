const { contextBridge, ipcRenderer, webUtils } = require("electron");

const arg = (key) => (process.argv.find((a) => a.startsWith(`--aced-${key}=`)) || "").split("=")[1];

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

contextBridge.exposeInMainWorld("aced", {
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
  // Dropped files are added by the File objects the drop brought, never by a path the page
  // names: a File made up by the page has no place on disk, so nothing else can be read.
  addMaterial: (id, files) => {
    const paths = [];
    for (const file of Array.from(files || [])) {
      try {
        const where = typeof file === "object" && file ? webUtils.getPathForFile(file) : "";
        if (where) paths.push(where);
      } catch {
        // not a File
      }
    }
    return call("material:add", id, paths);
  },
  // ⌘V: files copied in the Finder, a screenshot or picture on the clipboard, or text.
  pasteMaterial: (id) => call("material:paste", id),
  // Dropped data that has no place on disk (a picture dragged out of a browser): its bytes.
  addBytes: (id, items) => call("material:bytes", id, items),
  // Sharing, from Aced's own window: `options.way` is one of link, airdrop, messages, mail,
  // copy, save (the Aced file, with the material in `options.materials`), pdf, web or more.
  shareExam: (id, options) => call("share:send", id, options),
  // Which of AirDrop, Messages and Mail this Mac has set up: { airdrop, messages, mail }.
  shareServices: () => call("share:services"),
  // Whether this Aced makes links (it has a share service): true or false.
  shareLinks: () => call("share:links"),
  copyText: (text) => call("share:copyText", text),
  // What the person wrote in a book (ui/ink.js): per page, kept on this Mac only.
  inkLoad: (hash) => call("ink:load", hash),
  inkSave: (hash, page, data) => call("ink:save", hash, page, data),
  // The person's own copy of a book a shared exam names: from a drop (File objects), or chosen.
  supplyBook: (id, materialId, files) => {
    const paths = [];
    for (const file of Array.from(files || [])) {
      try {
        const where = typeof file === "object" && file ? webUtils.getPathForFile(file) : "";
        if (where) paths.push(where);
      } catch {
        // not a File
      }
    }
    return call("material:supply", id, materialId, paths);
  },
  // "Read with AI": another try for pictures the AI could not read.
  seeMaterial: (id, materialId) => call("material:see", id, materialId),
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
  // An exam changed without the window asking (the AI has read a picture).
  onExam: on("exam"),
  // An Aced file was opened from the Finder or the menu: { id, exam, problems }.
  onOpened: on("opened"),
  // A short word from the app for the person (the code of a sentence in ui/i18n.js), e.g. while a link is fetched.
  onNotice: on("notice"),
  // Files opened from the Finder that are not Aced files: { token, names }. `addHanded` adds
  // them to the exam on screen (the paths never come through here), or drops them (id null).
  onHanded: on("handed"),
  addHanded: (token, id) => call("files:handed", token, id),

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
