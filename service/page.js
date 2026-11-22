// The page a link to a shared exam opens: "Open in Aced", how to get Aced, and the plan to
// read, unlocked here in the browser with the key after "#". That key never leaves this page:
// it is not sent to the service (browsers never send what follows "#"), and this page talks to
// nothing but the service it came from, for the locked file.
"use strict";
(function () {
  const ID = /^[A-Za-z0-9_-]{22}$/;
  const KEY = /^[A-Za-z0-9_-]{43}$/;
  const MAGIC = [0x41, 0x43, 0x44, 0x31]; // "ACD1"
  const de = /^de\b/i.test(navigator.language || "");
  const T = de
    ? {
        shared: "Eine geteilte Prüfung",
        openInAced: "In Aced öffnen",
        openNote: "Aced holt die Prüfung und öffnet sie bei 0 %. Nichts davon geht an eine KI.",
        getTitle: "Noch kein Aced?",
        getText: "Aced ist gratis für den Mac. Öffne das Terminal, füge diese Zeile ein und drück Enter. Danach klick oben auf «In Aced öffnen».",
        getMore: "Mehr über Aced:",
        copy: "Kopieren",
        copied: "Kopiert",
        planTitle: "Der Plan",
        planNote: "Nur zum Lesen. In Aced hakst du ab, löst die Aufgaben und machst die Probeprüfung.",
        footer: "Der Link gilt 30 Tage. Die Prüfung ist verschlossen; der Schlüssel steht nur im Link.",
        loading: "Wird geholt …",
        gone: "Dieser Link ist abgelaufen",
        goneText: "Ein Link gilt 30 Tage. Lass dir einen neuen schicken.",
        broken: "Dieser Link ist unvollständig",
        brokenText: "Ein Teil des Links fehlt oder wurde verändert. Kopiere ihn nochmals ganz oder lass dir einen neuen schicken.",
        offline: "Die Prüfung konnte nicht geholt werden",
        offlineText: "Prüf deine Verbindung und lade die Seite neu.",
        none: "Hier öffnen sich Prüfungen, die jemand mit Aced geteilt hat.",
        examOn: (d) => `Prüfung am ${d}`,
        read: (a, b) => (a === b ? `Lesen: S. ${a}` : `Lesen: S. ${a}–${b}`),
        solve: (p, l) => `Lösen: S. ${p}, ${l.join(", ")}`,
        quiz: (n) => `${n} Fragen`,
        topics: (n) => `${n} Themen`,
      }
    : {
        shared: "A shared exam",
        openInAced: "Open in Aced",
        openNote: "Aced fetches the exam and opens it at 0%. None of it goes to an AI.",
        getTitle: "No Aced yet?",
        getText: "Aced is free for the Mac. Open Terminal, paste this line and press Return. Then click “Open in Aced” above.",
        getMore: "More about Aced:",
        copy: "Copy",
        copied: "Copied",
        planTitle: "The plan",
        planNote: "To read only. In Aced you tick steps off, solve the exercises and take the mock exam.",
        footer: "The link works for 30 days. The exam is locked; the key is only in the link.",
        loading: "Fetching …",
        gone: "This link has run out",
        goneText: "A link works for 30 days. Ask for a new one.",
        broken: "This link is not complete",
        brokenText: "A part of the link is missing or was changed. Copy all of it again, or ask for a new one.",
        offline: "The exam could not be fetched",
        offlineText: "Check your connection and load the page again.",
        none: "Exams someone shared with Aced open here.",
        examOn: (d) => `Exam on ${d}`,
        read: (a, b) => (a === b ? `Read p. ${a}` : `Read pp. ${a}–${b}`),
        solve: (p, l) => `Solve p. ${p}: ${l.join(", ")}`,
        quiz: (n) => `${n} questions`,
        topics: (n) => `${n} topics`,
      };
  document.documentElement.lang = de ? "de" : "en";
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = T[el.dataset.t];
  const $ = (id) => document.getElementById(id);

  $("copyLine").addEventListener("click", () => {
    const done = () => {
      $("copyLine").textContent = T.copied;
      setTimeout(() => ($("copyLine").textContent = T.copy), 1600);
    };
    if (navigator.clipboard) navigator.clipboard.writeText($("installLine").textContent).then(done, () => {});
  });

  function problem(title, text) {
    $("open").hidden = true;
    $("problem").hidden = false;
    $("problemTitle").textContent = title;
    $("problemText").textContent = text;
  }

  const id = (/^\/s\/([^/]+)$/.exec(location.pathname) || [])[1] || "";
  const key = location.hash.slice(1);
  if (!id && !key) {
    $("problem").hidden = false;
    $("problemTitle").textContent = "Aced";
    $("problemText").textContent = T.none;
    return;
  }
  if (!ID.test(id) || !KEY.test(key)) return problem(T.broken, T.brokenText);

  // The link for the app: only the id and the key, checked above, in Aced's own form.
  $("open").hidden = false;
  $("name").textContent = T.shared;
  $("when").textContent = T.loading;
  $("openApp").href = `aced://s/${id}#${key}`;

  const bytesOf = (b64) => {
    const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };

  /** The text of "aced.json" in the Aced file (a zip), read from its central directory. */
  async function acedJson(zip) {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("zip");
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    for (let n = 0; n < count && at + 46 <= zip.length; n++) {
      if (view.getUint32(at, true) !== 0x02014b50) throw new Error("zip");
      const method = view.getUint16(at + 10, true);
      const packed = view.getUint32(at + 20, true);
      const size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const extra = view.getUint16(at + 30, true);
      const comment = view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
      at += 46 + nameLength + extra + comment;
      if (name !== "aced.json") continue;
      if (size > 16 * 1048576 || view.getUint32(local, true) !== 0x04034b50) throw new Error("zip");
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = zip.subarray(start, start + packed);
      if (method === 0) return new TextDecoder().decode(data);
      if (method !== 8) throw new Error("zip");
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new TextDecoder().decode(await new Response(stream).arrayBuffer());
    }
    throw new Error("zip");
  }

  function show(doc) {
    const exam = doc && typeof doc.exam === "object" && doc.exam ? doc.exam : {};
    const name = typeof exam.name === "string" && exam.name.trim() ? exam.name.trim().slice(0, 120) : T.shared;
    $("name").textContent = name;
    document.title = `Aced: ${name}`;
    const date = typeof exam.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(exam.date) ? new Date(exam.date + "T12:00:00") : null;
    const topics = doc && doc.strategy && Array.isArray(doc.strategy.topics) ? doc.strategy.topics.slice(0, 60) : [];
    const parts = [];
    if (date && !Number.isNaN(date.getTime())) parts.push(T.examOn(new Intl.DateTimeFormat(de ? "de-CH" : "en-GB", { weekday: "long", day: "numeric", month: "long" }).format(date)));
    if (topics.length) parts.push(T.topics(topics.length));
    $("when").textContent = parts.join(" · ");
    if (!topics.length) return;
    const titles = new Map((Array.isArray(doc.materials) ? doc.materials : []).map((m) => [m && m.id, m && typeof m.title === "string" ? m.title.slice(0, 120) : ""]));
    const int = (v) => (Number.isInteger(v) && v > 0 && v < 100000 ? v : null);
    const list = $("topics");
    for (const topic of topics.filter((x) => x && typeof x === "object").sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))) {
      const li = document.createElement("li");
      const h = document.createElement("h3");
      h.textContent = typeof topic.title === "string" ? topic.title.slice(0, 300) : "—";
      li.append(h);
      if (typeof topic.why === "string" && topic.why.trim()) {
        const p = document.createElement("p");
        p.className = "muted";
        p.textContent = topic.why.slice(0, 400);
        li.append(p);
      }
      const steps = document.createElement("ul");
      for (const step of Array.isArray(topic.steps) ? topic.steps.slice(0, 40) : []) {
        if (!step || typeof step !== "object") continue;
        const book = titles.get(step.material) || "";
        let text = "";
        if (step.kind === "read" && int(step.from)) text = T.read(int(step.from), int(step.to) || int(step.from)) + (typeof step.chapter === "string" && step.chapter ? ` (${step.chapter.slice(0, 120)})` : "");
        else if (step.kind === "solve" && int(step.page) && Array.isArray(step.labels)) text = T.solve(int(step.page), step.labels.slice(0, 30).map((l) => String(l).slice(0, 24)));
        else if (step.kind === "quiz" && int(step.questions)) text = T.quiz(int(step.questions));
        if (!text) continue;
        const item = document.createElement("li");
        item.textContent = book && step.kind !== "quiz" ? `${text} · ${book}` : text;
        steps.append(item);
      }
      if (steps.children.length) li.append(steps);
      list.append(li);
    }
    $("plan").hidden = false;
  }

  (async () => {
    let answer;
    try {
      answer = await fetch(`/api/s/${id}`, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    } catch {
      return problem(T.offline, T.offlineText);
    }
    if (answer.status === 404) return problem(T.gone, T.goneText);
    if (!answer.ok) return problem(T.offline, T.offlineText);
    try {
      const blob = new Uint8Array(await answer.arrayBuffer());
      if (blob.length < 33 || MAGIC.some((b, i) => blob[i] !== b)) throw new Error("magic");
      const lock = await crypto.subtle.importKey("raw", bytesOf(key), "AES-GCM", false, ["decrypt"]);
      const zip = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(4, 16), additionalData: new Uint8Array(MAGIC), tagLength: 128 }, lock, blob.subarray(16)));
      show(JSON.parse(await acedJson(zip)));
    } catch {
      problem(T.broken, T.brokenText);
    }
  })();
})();
