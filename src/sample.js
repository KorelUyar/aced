// Invented exams for `--sample`: what the app looks like once the engine has done its work.
// Same shape as real exams (see store.js and engine.js). The texts are German on purpose:
// plans, formulas and questions follow the language of the material, not of the interface.
// Nothing in this file comes from a real book, and there are no book files behind it.
const answers = require("./answers");

function inDays(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

const book = (id, title, pages) => ({ id, kind: "book", type: "pdf", hash: "sample-" + id, title, pages, chars: pages * 2400, offset: 0, scanned: false });
const text = (id, kind, title) => ({ id, kind, type: "text", hash: "sample-" + id, title, pages: 1, chars: 900, offset: 0, scanned: false });

/** topic(id, title, share, why, skipCost, objectives, [[kind, ...]]) with steps numbered like the engine does. */
function topic(id, title, share, why, skipCost, objectives, steps, material) {
  let r = 0;
  let s = 0;
  return {
    id,
    title,
    share,
    why,
    skipCost,
    objectives,
    order: steps[0][1],
    steps: steps.map((step) => {
      if (step[0] === "read") return { id: `${id}/r${r++}`, kind: "read", material, from: step[1], to: step[2], chapter: step[3], minutes: step[4] };
      if (step[0] === "solve") return { id: `${id}/s${s++}`, kind: "solve", material, page: step[1], labels: step[2], minutes: step[3], unconfirmed: [] };
      return { id: `${id}/q`, kind: "quiz", questions: step[1], minutes: step[2] };
    }),
  };
}

// What the AI writes per topic since 0.6: the core of its pages, an example, what to do, and
// where the details are. Invented for the sample, like the book it names.
const summary = (core, example, todo, pages) => ({ core, example: example && { task: example[0], steps: example[1], result: example[2] }, todo, pages: pages.map(([from, to, what]) => ({ material: "m1", from, to, what })), model: "sample", made: inDays(-1) });

const SUMMARIES = {
  t1: summary(
    [
      "Die Scheitelpunktform lautet $f(x) = a(x - d)^2 + e$. Der Scheitelpunkt ist $S(d \\mid e)$.",
      "$a$ bestimmt die Form: $a > 0$ öffnet nach oben, $a < 0$ nach unten. Mit $|a| > 1$ ist die Parabel schmaler, mit $|a| < 1$ breiter als die Normalparabel.",
      "Von der Normalform zur Scheitelpunktform mit quadratischer Ergänzung: $x^2 + px = \\left(x + \\tfrac{p}{2}\\right)^2 - \\left(\\tfrac{p}{2}\\right)^2$.",
      "Vorsicht beim Vorzeichen: Bei $(x - 3)^2$ liegt der Scheitelpunkt bei $x = 3$, bei $(x + 3)^2$ bei $x = -3$.",
      "Steht vor $x^2$ eine Zahl, klammere sie zuerst aus: $2x^2 - 8x = 2(x^2 - 4x)$.",
    ],
    ["Bringe $f(x) = x^2 - 6x + 5$ in die Scheitelpunktform.", ["$x^2 - 6x = (x - 3)^2 - 9$", "$f(x) = (x - 3)^2 - 9 + 5 = (x - 3)^2 - 4$"], "$S(3 \\mid -4)$, die Parabel ist nach oben geöffnet"],
    ["Lies die quadratische Ergänzung oben und das Beispiel einmal genau durch.", "Löse die Aufgaben 4, 5 und 7 auf S. 92 und gib jeweils den Scheitelpunkt ein.", "Zeichne die Parabel aus Aufgabe 11 auf S. 93 vom Scheitelpunkt aus."],
    [[88, 89, "Scheitelpunktform und quadratische Ergänzung"], [90, 91, "Parabeln zeichnen"]],
  ),
  t2: summary(
    [
      "Nullstellen sind die $x$ mit $f(x) = 0$: Dort schneidet die Parabel die $x$-Achse.",
      "Für $ax^2 + bx + c = 0$ gilt die Mitternachtsformel $x_{1,2} = \\dfrac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$.",
      "Bring die Gleichung zuerst auf die Form $ax^2 + bx + c = 0$ und lies $a$, $b$ und $c$ mit ihren Vorzeichen ab.",
      "Fehlt $c$, geht Ausklammern schneller: $x(ax + b) = 0$ gibt $x_1 = 0$ und $x_2 = -\\tfrac{b}{a}$.",
    ],
    ["Löse $2x^2 - 8x + 6 = 0$.", ["$a = 2,\\ b = -8,\\ c = 6$", "$b^2 - 4ac = 64 - 48 = 16$", "$x_{1,2} = \\dfrac{8 \\pm 4}{4}$"], "$x_1 = 3,\\ x_2 = 1$"],
    ["Schreib die Mitternachtsformel einmal auswendig auf.", "Löse die Aufgaben 2, 3 und 6 auf S. 99.", "Prüfe jede Lösung durch Einsetzen."],
    [[96, 97, "Die Mitternachtsformel"], [98, 98, "Beispiele"]],
  ),
  t3: summary(
    [
      "Lies zuerst die Frage: Was gesucht ist, wird dein $x$.",
      "Übersetze den Text Satz für Satz in eine Gleichung, zum Beispiel Fläche $=$ Länge $\\cdot$ Breite.",
      "Bring die Gleichung auf $ax^2 + bx + c = 0$ und löse sie mit der Mitternachtsformel.",
      "Prüfe, welche Lösung zur Aufgabe passt: Negative Längen oder Zeiten fallen weg.",
    ],
    ["Ein Rechteck ist 3 cm länger als breit und hat 40 cm² Fläche. Wie breit ist es?", ["$x(x + 3) = 40$", "$x^2 + 3x - 40 = 0$", "$x_1 = 5,\\ x_2 = -8$"], "5 cm breit ($-8$ fällt weg)"],
    ["Löse Aufgabe 1 auf S. 106 Schritt für Schritt wie im Beispiel.", "Löse Aufgabe 4 und prüfe, welche Lösung passt."],
    [[104, 105, "So gehst du bei Textaufgaben vor"]],
  ),
  t4: summary(
    ["Die Diskriminante ist $D = b^2 - 4ac$, der Teil unter der Wurzel.", "$D > 0$: zwei Lösungen. $D = 0$: genau eine. $D < 0$: keine reelle Lösung.", "Für die Parabel heisst das: zwei, ein oder kein Schnittpunkt mit der $x$-Achse."],
    ["Wie viele Lösungen hat $x^2 + 2x + 5 = 0$?", ["$D = 2^2 - 4 \\cdot 1 \\cdot 5 = -16$", "$D < 0$"], "keine reelle Lösung"],
    ["Löse die Aufgaben 12 und 13 auf S. 100: nur $D$ berechnen und die Anzahl Lösungen angeben."],
    [[98, 98, "Die Diskriminante"]],
  ),
  t5: summary(
    ["Schnittpunkte findest du durch Gleichsetzen: $f(x) = g(x)$.", "Alles auf eine Seite bringen gibt eine quadratische Gleichung; ihre Lösungen sind die $x$ der Schnittpunkte.", "Die $y$ bekommst du durch Einsetzen in die einfachere Funktion, meist die Gerade.", "Die Diskriminante sagt, wie viele Schnittpunkte es gibt: zwei, einen (die Gerade berührt) oder keinen."],
    ["Wo schneiden sich $f(x) = x^2$ und $g(x) = x + 2$?", ["$x^2 = x + 2$", "$x^2 - x - 2 = 0$", "$x_1 = 2,\\ x_2 = -1$"], "$S_1(2 \\mid 4)$ und $S_2(-1 \\mid 1)$"],
    ["Löse die Aufgaben 3 und 5 auf S. 112.", "Gib jeden Schnittpunkt mit $x$ und $y$ an."],
    [[110, 111, "Parabel und Gerade"]],
  ),
  t6: summary(
    ["Für $x^2 + px + q = 0$ mit den Lösungen $x_1$ und $x_2$ gilt: $x_1 + x_2 = -p$ und $x_1 \\cdot x_2 = q$.", "Damit prüfst du Lösungen oder errätst ganzzahlige Lösungen.", "Das gilt nur, wenn vor $x^2$ eine 1 steht: Teile sonst zuerst durch $a$."],
    ["Errate die Lösungen von $x^2 - 5x + 6 = 0$.", ["Gesucht: Summe 5, Produkt 6", "$2 + 3 = 5$ und $2 \\cdot 3 = 6$"], "$x_1 = 2,\\ x_2 = 3$"],
    ["Löse die Aufgaben 2 und 4 auf S. 103 mit Vieta.", "Prüfe die Lösungen durch Einsetzen."],
    [[101, 102, "Der Satz von Vieta"]],
  ),
};

// The book's exercises as tasks in the app since 0.6: the text as printed, the result, a hint and
// the worked solution. Invented for the sample, like the book.
const task = (id, step, page, label, prompt, result, hint, solution, minutes = 5) => ({ id, step, material: "m1", page, label, prompt, figure: null, ...result, hint, solution, checked: "book", variant: false, minutes });
const TASKS = {
  t1: [
    task("t1/s0/4", "t1/s0", 92, "4", "Bestimme den Scheitelpunkt der Parabel $f(x) = x^2 - 4x + 1$.", { type: "numbers", values: [2, -3], ordered: true, tolerance: 0, answer: "$S(2 \\mid -3)$" }, "Ergänze quadratisch: $x^2 - 4x = (x - 2)^2 - 4$.", ["$f(x) = (x - 2)^2 - 4 + 1$", "$f(x) = (x - 2)^2 - 3$", "Scheitelpunkt $S(2 \\mid -3)$"]),
    task("t1/s0/5", "t1/s0", 92, "5", "Bestimme den Scheitelpunkt der Parabel $f(x) = x^2 + 6x + 4$.", { type: "numbers", values: [-3, -5], ordered: true, tolerance: 0, answer: "$S(-3 \\mid -5)$" }, "Die Hälfte von 6 ist 3: $x^2 + 6x = (x + 3)^2 - 9$.", ["$f(x) = (x + 3)^2 - 9 + 4$", "$f(x) = (x + 3)^2 - 5$", "Scheitelpunkt $S(-3 \\mid -5)$"]),
    task("t1/s0/7", "t1/s0", 92, "7", "Bestimme den Scheitelpunkt der Parabel $f(x) = 2x^2 - 8x + 3$.", { type: "numbers", values: [2, -5], ordered: true, tolerance: 0, answer: "$S(2 \\mid -5)$" }, "Klammere zuerst die 2 aus: $2x^2 - 8x = 2(x^2 - 4x)$.", ["$f(x) = 2(x^2 - 4x) + 3$", "$f(x) = 2\\left((x - 2)^2 - 4\\right) + 3$", "$f(x) = 2(x - 2)^2 - 5$", "Scheitelpunkt $S(2 \\mid -5)$"], 7),
    task("t1/s1/11", "t1/s1", 93, "11", "Zeichne die Parabel $f(x) = (x - 1)^2 - 2$ in ein Koordinatensystem. Wo schneidet sie die $y$-Achse?", { type: "number", value: -1, tolerance: 0, answer: "$y = -1$" }, "Die $y$-Achse ist $x = 0$: Setze $0$ ein.", ["Scheitelpunkt $S(1 \\mid -2)$, nach oben geöffnet", "$f(0) = (0 - 1)^2 - 2 = 1 - 2$", "Schnittpunkt mit der $y$-Achse: $(0 \\mid -1)$"], 8),
  ],
  t2: [
    task("t2/s0/2", "t2/s0", 99, "2", "Löse die Gleichung $x^2 - 7x + 12 = 0$.", { type: "numbers", values: [3, 4], tolerance: 0, answer: "$x_1 = 3,\\ x_2 = 4$" }, "$a = 1$, $b = -7$, $c = 12$; die Diskriminante ist $49 - 48 = 1$.", ["$x_{1,2} = \\dfrac{7 \\pm \\sqrt{1}}{2}$", "$x_1 = 4,\\ x_2 = 3$"]),
    task("t2/s0/3", "t2/s0", 99, "3", "Löse die Gleichung $2x^2 + 3x - 2 = 0$.", { type: "numbers", values: [0.5, -2], tolerance: 0.005, answer: "$x_1 = 0.5,\\ x_2 = -2$" }, "$b^2 - 4ac = 9 + 16 = 25$.", ["$x_{1,2} = \\dfrac{-3 \\pm 5}{4}$", "$x_1 = \\tfrac{1}{2},\\ x_2 = -2$"]),
    task("t2/s0/6", "t2/s0", 99, "6", "Wie viele Lösungen hat $x^2 - 6x + 9 = 0$?", { type: "choice", choices: ["Keine", "Genau eine", "Zwei"], correct: 1, answer: "Genau eine" }, "Berechne die Diskriminante $b^2 - 4ac$.", ["$D = 36 - 36 = 0$", "$D = 0$: genau eine Lösung, $x = 3$"], 3),
  ],
};

const empty = () => ({ done: {}, sets: {}, again: [], results: [], usage: { input: 0, cached: 0, output: 0, cost: 0 } });
const formula = (name, latex, note, page) => ({ name, latex, note, material: "m1", page });

function exams(lang = "en") {
  const list = sampleExams(lang);
  // The maths exam has its summaries and tasks (ACED_SAMPLE_OLD=1: as an exam from before 0.6).
  if (!process.env.ACED_SAMPLE_OLD) for (const t of list[0].strategy.topics) Object.assign(t, { summary: SUMMARIES[t.id], tasks: TASKS[t.id] || [] });
  // ACED_SAMPLE_SHARED=1 (pictures of 0.5): the first exam as a friend sees it after opening
  // the Aced file someone shared: no ticks or results, and the book still to be added.
  if (process.env.ACED_SAMPLE_SHARED === "1") {
    const e = list[0];
    Object.assign(e, empty(), { shared: { on: inDays(-1) } });
    e.materials = e.materials.filter((m) => m.kind !== "oldExam").map((m) => (m.kind === "book" && m.from !== "pictures" ? { ...m, missing: true } : m));
  }
  return list;
}

function sampleExams(lang) {
  const today = inDays(0);
  return [
    {
      id: "sample-math",
      name: "Mathematik: Quadratische Funktionen",
      date: inDays(6),
      time: { mode: "perDay", minutes: 25 },
      scale: "ch",
      target: 5,
      pace: "sprint",
      createdAt: inDays(-1) + "T16:00:00.000Z",
      materials: [
        book("m1", "Mathematik 1: Algebra und Funktionen", 312),
        // A Word worksheet, and screenshots of an exercise sheet that the AI has read.
        { ...book("m4", "Arbeitsblatt 7: Quadratische Gleichungen", 2), kind: "notes", from: "docx", format: "docx", chars: 1900 },
        // (Named as a Mac names screenshots, in the language of the app.)
        { ...book("m5", lang === "de" ? "Bildschirmfoto 2026-11-20 um 14.02.11 (3 Seiten)" : "Screenshot 2026-11-20 at 14.02.11 (3 pages)", 3), kind: "notes", from: "pictures", files: 3, recognised: true, read: "ai", model: "claude-opus-5-5", chars: 2400 },
        text("m2", "objectives", "Lernziele Semesterprüfung"),
        text("m3", "oldExam", "Prüfung 2025, Serie A"),
      ],
      strategy: {
        createdOn: inDays(-1),
        model: "sample",
        approach:
          "Fang mit der Scheitelpunktform an: Sie steckt in fast jeder Aufgabe. Rechne lieber wenige Aufgaben ganz durch, als viele anzuschauen.",
        objectives: [
          "Ich kann die Scheitelpunktform aus der Normalform herleiten.",
          "Ich kann den Scheitelpunkt ablesen und die Parabel zeichnen.",
          "Ich kann beschreiben, wie a, d und e die Parabel verändern.",
          "Ich kann Nullstellen mit der Mitternachtsformel berechnen.",
          "Ich kann Nullstellen durch Faktorisieren bestimmen.",
          "Ich kann Textaufgaben in eine quadratische Gleichung übersetzen.",
          "Ich kann die Lösung einer Textaufgabe im Sachzusammenhang deuten.",
          "Ich kann mit der Diskriminante die Anzahl Lösungen bestimmen.",
          "Ich kann Schnittpunkte von Parabel und Gerade berechnen.",
        ],
        objectivesGuessed: false,
        checks: { exercises: 12, confirmed: 12, moved: 0, unconfirmed: 0, rangesDropped: 0 },
        pagesRead: 31,
        skipped: [],
        topics: [
          topic(
            "t1",
            "Scheitelpunktform und Parabel zeichnen",
            0.3,
            "Kam in der Prüfung 2025 in 3 von 9 Aufgaben vor. Wer die Scheitelpunktform sicher kann, löst auch die Textaufgaben schneller.",
            "Ohne die Scheitelpunktform fehlt die Grundlage für fast ein Drittel der Punkte.",
            [0, 1, 2],
            [["read", 88, 91, "4.2 Scheitelpunktform", 15], ["solve", 92, ["4", "5", "7"], 20], ["solve", 93, ["11"], 15], ["quiz", 3, 10]],
            "m1",
          ),
          topic(
            "t2",
            "Nullstellen mit der Mitternachtsformel",
            0.25,
            "Reine Übungssache und fast sichere Punkte. Drei Aufgaben reichen, um die Formel fehlerfrei anzuwenden.",
            "Nullstellen werden in jeder Prüfung verlangt.",
            [3, 4],
            [["read", 96, 98, "4.4 Nullstellen", 15], ["solve", 99, ["2", "3", "6"], 25], ["quiz", 4, 10]],
            "m1",
          ),
          topic(
            "t3",
            "Textaufgaben mit quadratischen Gleichungen",
            0.2,
            "Gibt viele Punkte pro Aufgabe. Übe das Aufstellen der Gleichung, das Rechnen kannst du dann schon.",
            "Textaufgaben geben am meisten Punkte pro Aufgabe.",
            [5, 6],
            [["read", 104, 105, "4.6 Anwendungen", 10], ["solve", 106, ["1", "4"], 20], ["quiz", 3, 10]],
            "m1",
          ),
          topic(
            "t4",
            "Diskriminante und Anzahl Lösungen",
            0.1,
            "Kurzes Thema, das auf der Mitternachtsformel aufbaut. Zwei Aufgaben genügen.",
            "Kostet höchstens eine Teilaufgabe.",
            [7],
            [["read", 98, 98, "4.4 Nullstellen", 5], ["solve", 100, ["12", "13"], 15], ["quiz", 3, 10]],
            "m1",
          ),
          topic(
            "t5",
            "Schnittpunkte von Parabel und Gerade",
            0.1,
            "Steht in einem Lernziel und kam 2025 in einer Aufgabe vor.",
            "Wenn es drankommt, fehlt dir etwa eine halbe Note.",
            [8],
            [["read", 110, 111, "4.8 Parabel und Gerade", 15], ["solve", 112, ["3", "5"], 20], ["quiz", 3, 10]],
            "m1",
          ),
          topic(
            "t6",
            "Satz von Vieta",
            0.05,
            "Steht im Buch, aber in keinem deiner Lernziele.",
            "Kam in der alten Prüfung nicht vor: sehr kleines Risiko.",
            [],
            [["read", 101, 102, "4.5 Satz von Vieta", 15], ["solve", 103, ["2", "4"], 15], ["quiz", 3, 10]],
            "m1",
          ),
        ],
      },
      ...empty(),
      done: {
        "t1/sum": { date: inDays(-1), minutes: 3, at: 0.5 },
        "t1/r0": { date: inDays(-1), minutes: 15, at: 1 },
        "t1/s0": { date: inDays(-1), minutes: 20, at: 2 },
        "t1/s1": { date: inDays(-1), minutes: 15, at: 3 },
        "t2/r0": { date: today, minutes: 15, at: 4 },
      },
      formulas: [
        {
          topicId: "t1",
          formulas: [
            formula("Scheitelpunktform", "f(x) = a(x - d)^2 + e", "Scheitelpunkt $S(d \\mid e)$; $a$ öffnet und streckt die Parabel.", 88),
            formula("Quadratische Ergänzung", "x^2 + px = \\left(x + \\tfrac{p}{2}\\right)^2 - \\left(\\tfrac{p}{2}\\right)^2", "So wird aus der Normalform die Scheitelpunktform.", 90),
          ],
        },
        {
          topicId: "t2",
          formulas: [
            formula("Mitternachtsformel", "x_{1,2} = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}", "Für $ax^2 + bx + c = 0$.", 96),
            formula("Diskriminante", "D = b^2 - 4ac", "$D > 0$: zwei Lösungen, $D = 0$: eine, $D < 0$: keine.", 98),
          ],
        },
        { topicId: "t3", formulas: [formula("Rechteck mit festem Umfang", "A(x) = x \\left(\\tfrac{U}{2} - x\\right)", "Die grösste Fläche liegt im Scheitelpunkt.", 104)] },
      ],
      sets: {
        "final#0": {
          key: "final#0",
          final: true,
          variant: 0,
          topicIds: ["t1", "t2", "t3", "t4", "t5"],
          createdOn: today,
          draft: {},
          result: null,
          spare: { t2: [{ material: "m1", page: 100, labels: ["8", "9"], minutes: 15 }] },
          questions: [
            { id: "final#0/k0", topicId: "t1", type: "number", prompt: "Die Parabel $f(x) = (x - 3)^2 + 2$: Wie gross ist der kleinste Funktionswert?", value: 2, unit: "", tolerance: 0, answer: "2", solution: "Der Scheitelpunkt ist $S(3 \\mid 2)$ und die Parabel ist nach oben geöffnet: Der kleinste Wert ist $e = 2$.", points: 1, material: "m1", page: 89 },
            { id: "final#0/k1", topicId: "t2", type: "numbers", prompt: "Löse $x^2 - 5x + 6 = 0$. Gib beide Lösungen an.", values: [2, 3], unit: "", tolerance: 0, answer: "$x_1 = 2$, $x_2 = 3$", solution: "$D = 25 - 24 = 1$, also $x_{1,2} = \\frac{5 \\pm 1}{2}$.", points: 2, material: "m1", page: 97 },
            { id: "final#0/k2", topicId: "t4", type: "choice", prompt: "Wie viele Lösungen hat $x^2 + 4x + 5 = 0$?", choices: ["Keine", "Genau eine", "Zwei", "Unendlich viele"], correct: 0, answer: "Keine", solution: "$D = 16 - 20 = -4 < 0$: keine Lösung.", points: 1, material: "m1", page: 98 },
            { id: "final#0/k3", topicId: "t3", type: "number", prompt: "Ein Rechteck hat den Umfang 40 m. Wie gross ist seine grösste mögliche Fläche in m²?", value: 100, unit: "m²", tolerance: 0, answer: "100 m²", solution: "$A(x) = x(20 - x)$ hat den Scheitelpunkt bei $x = 10$: $A = 10 \\cdot 10 = 100$.", points: 2, material: "m1", page: 104 },
            { id: "final#0/k4", topicId: "t1", type: "text", prompt: "Bringe $f(x) = x^2 - 6x + 5$ in die Scheitelpunktform.", answer: "$f(x) = (x - 3)^2 - 4$", solution: "Quadratisch ergänzen: $x^2 - 6x + 9 - 9 + 5 = (x - 3)^2 - 4$.", points: 2, material: "m1", page: 90, sampleMark: { points: 0, note: "Beim Ausgleichen ist das Vorzeichen verrutscht: $-9 + 5$ ergibt $-4$, nicht $+4$." } },
            { id: "final#0/k5", topicId: "t5", type: "numbers", prompt: "Bei welchen $x$ schneidet die Parabel $y = x^2$ die Gerade $y = x + 2$?", values: [-1, 2], unit: "", tolerance: 0, answer: "$x_1 = -1$, $x_2 = 2$", solution: "$x^2 = x + 2$, also $x^2 - x - 2 = 0$ und $(x + 1)(x - 2) = 0$.", points: 2, material: "m1", page: 110 },
          ],
        },
      },
    },
    {
      id: "sample-law",
      name: "Wirtschaft und Recht: Vertragsrecht",
      date: inDays(13),
      time: { mode: "perDay", minutes: 30 },
      scale: "ch",
      target: 5,
      pace: "thorough",
      createdAt: inDays(-4) + "T16:00:00.000Z",
      materials: [book("m1", "Recht und Gesellschaft", 268), text("m2", "objectives", "Lernziele Vertragsrecht")],
      strategy: {
        createdOn: inDays(-4),
        model: "sample",
        approach: "Lerne die Begriffe an Fällen, nicht als Liste: Die Prüfung fragt fast nur Fallbeispiele.",
        objectives: ["Ich kann erklären, wie ein Vertrag entsteht.", "Ich kann die Formvorschriften nennen.", "Ich kann Vertragsmängel an Fällen erkennen.", "Ich kann die Folgen einer Anfechtung beschreiben."],
        objectivesGuessed: false,
        checks: { exercises: 3, confirmed: 3, moved: 0, unconfirmed: 0, rangesDropped: 0 },
        pagesRead: 22,
        skipped: [],
        topics: [
          topic("t1", "Entstehung eines Vertrags", 0.55, "Antrag, Annahme und Form sind die Grundlage für alle Fallbeispiele in der Prüfung.", "Ohne dieses Thema lassen sich die Fälle nicht lösen.", [0, 1], [["read", 142, 149, "7.1 Vertragsabschluss", 30], ["solve", 150, ["1", "2", "5"], 35], ["quiz", 5, 15]], "m1"),
          topic("t2", "Vertragsmängel und Anfechtung", 0.45, "Irrtum, Täuschung und Drohung kommen fast immer als Fall vor.", "Etwa die Hälfte der Fallaufgaben.", [2, 3], [["read", 156, 161, "7.3 Mängel des Vertrags", 25], ["quiz", 5, 15]], "m1"),
        ],
      },
      ...empty(),
      done: {
        "t1/r0": { date: inDays(-3), minutes: 30, at: 1 },
        "t1/s0": { date: inDays(-2), minutes: 35, at: 2 },
      },
      sets: {
        "topic:t2/q#0": {
          key: "topic:t2/q#0",
          final: false,
          variant: 0,
          stepId: "t2/q",
          topicIds: ["t2"],
          createdOn: inDays(-1),
          draft: {},
          result: null,
          spare: {},
          questions: [
            { id: "topic:t2/q#0/k0", topicId: "t2", type: "choice", prompt: "Lea kauft ein Velo, weil der Verkäufer verschweigt, dass der Rahmen gerissen ist. Welcher Mangel liegt vor?", choices: ["Absichtliche Täuschung", "Erklärungsirrtum", "Furchterregung", "Übervorteilung"], correct: 0, answer: "Absichtliche Täuschung", solution: "Der Verkäufer verschweigt den Mangel mit Absicht: Das ist Täuschung, nicht Irrtum.", points: 1, material: "m1", page: 157 },
            { id: "topic:t2/q#0/k1", topicId: "t2", type: "number", prompt: "Innert wie vielen Jahren muss ein Vertrag wegen Irrtums angefochten werden?", value: 1, unit: "Jahr", tolerance: 0, answer: "1 Jahr", solution: "Die Frist beträgt ein Jahr ab Entdeckung des Irrtums.", points: 1, material: "m1", page: 160 },
            { id: "topic:t2/q#0/k2", topicId: "t2", type: "text", prompt: "Wie heisst der Irrtum über eine notwendige Grundlage des Vertrags?", answer: "Grundlagenirrtum", solution: "Der Grundlagenirrtum ist der einzige Motivirrtum, der zur Anfechtung berechtigt.", points: 1, material: "m1", page: 158 },
          ],
        },
      },
    },
    {
      id: "sample-m323",
      name: "Modul 323: Funktional programmieren",
      date: inDays(24),
      time: { mode: "total", minutes: 600 },
      scale: "ch",
      target: 5.5,
      pace: "efficient",
      createdAt: inDays(0) + "T08:00:00.000Z",
      materials: [],
      strategy: null,
      ...empty(),
    },
  ];
}

/**
 * Marks a set without a model, for the sample exams: numbers and choices as in the real app,
 * text only when it is the expected text (or with the mark prepared for the screenshots).
 */
function marks(set, typed) {
  const tidy = (text) => String(text).toLowerCase().replace(/[\s$\\{}]/g, "");
  const out = {};
  for (const q of set.questions) {
    const given = typed[q.id];
    const text = typeof given === "string" ? given.trim() : "";
    const right =
      q.type === "choice" ? given === q.correct : !text ? false : q.type === "number" ? answers.numberRight(text, q.value, q.tolerance) : q.type === "numbers" ? answers.numbersRight(text, q.values, q.tolerance) : tidy(text) === tidy(q.answer);
    const prepared = !right && text && q.sampleMark;
    out[q.id] = { points: prepared ? q.sampleMark.points : right ? q.points : 0, max: q.points, note: prepared ? q.sampleMark.note : "" };
  }
  return out;
}

module.exports = { exams, marks };
