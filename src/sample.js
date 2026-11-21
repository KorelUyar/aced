// Invented exams for `--sample`: what the app looks like once the engine has done its work.
// Same shape as real exams (see store.js and engine.js). The texts are German on purpose:
// plans, quizzes and feedback follow the language of the material, not of the interface.
// Nothing in this file comes from a real book, and there are no book files behind it.

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

const empty = () => ({ done: {}, mastery: {}, attempts: {}, cards: {}, quizzes: {}, history: [], usage: { input: 0, cached: 0, output: 0, cost: 0 } });

function exams() {
  const today = inDays(0);
  return [
    {
      id: "sample-math",
      name: "Mathematik: Quadratische Funktionen",
      date: inDays(6),
      time: { mode: "perDay", minutes: 35 },
      scale: "ch",
      target: 5,
      pace: "sprint",
      createdAt: inDays(-1) + "T16:00:00.000Z",
      materials: [book("m1", "Mathematik 1: Algebra und Funktionen", 312), text("m2", "objectives", "Lernziele Semesterprüfung"), text("m3", "oldExam", "Prüfung 2025, Serie A")],
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
      done: { "t1/r0": { date: today, minutes: 15, at: 1 } },
      quizzes: {
        t1: {
          key: "t1",
          variant: 0,
          questions: [
            {
              id: "t1/k0",
              topicId: "t1",
              type: "choice",
              prompt: "Welchen Scheitelpunkt hat die Parabel $f(x) = (x - 3)^2 + 2$?",
              choices: ["$S(3 \\mid 2)$", "$S(-3 \\mid 2)$", "$S(3 \\mid -2)$", "$S(2 \\mid 3)$"],
              correct: 0,
              answer: "$S(3 \\mid 2)$",
              rubric: "1 Punkt für den richtigen Scheitelpunkt.",
              explain: "In der Scheitelpunktform $f(x) = a(x - d)^2 + e$ liegt der Scheitelpunkt bei $S(d \\mid e)$. Das Vorzeichen in der Klammer dreht sich um: aus $(x - 3)$ wird $d = 3$.",
              points: 1,
              material: "m1",
              page: 89,
            },
            {
              id: "t1/k1",
              topicId: "t1",
              type: "short",
              prompt: "Bringe $f(x) = x^2 - 6x + 5$ in die Scheitelpunktform und gib den Scheitelpunkt an.",
              answer: "$f(x) = (x - 3)^2 - 4$, Scheitelpunkt $S(3 \\mid -4)$",
              rubric: "1 Punkt quadratische Ergänzung, 1 Punkt richtig ausgeglichen, 1 Punkt Scheitelpunkt.",
              explain: "Quadratisch ergänzen: $x^2 - 6x + 9 - 9 + 5$.",
              points: 3,
              material: "m1",
              page: 90,
              // Stands in for the AI's correction, so the screenshots need no AI.
              sampleAnswer: "f(x) = (x − 3)² + 4, also S(3 | 4)",
              sampleFeedback: {
                points: 2,
                feedback: "Die quadratische Ergänzung mit $(x - 3)^2$ stimmt. Beim Ausgleichen ist dir das Vorzeichen verrutscht: $-9 + 5$ ergibt $-4$, nicht $+4$.",
                correct: "$f(x) = (x - 3)^2 - 4$, Scheitelpunkt $S(3 \\mid -4)$",
              },
            },
            {
              id: "t1/k2",
              topicId: "t1",
              type: "choice",
              prompt: "Wie sieht die Parabel $f(x) = -2(x + 1)^2 + 3$ im Vergleich zur Normalparabel aus?",
              choices: ["Nach unten geöffnet und schmaler", "Nach unten geöffnet und breiter", "Nach oben geöffnet und schmaler", "Nach oben geöffnet und breiter"],
              correct: 0,
              answer: "Nach unten geöffnet und schmaler",
              rubric: "1 Punkt für die richtige Auswahl.",
              explain: "$a = -2$: Das Minus öffnet die Parabel nach unten, und weil der Betrag grösser als 1 ist, wird sie schmaler.",
              points: 1,
              material: "m1",
              page: 88,
            },
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
        checks: { exercises: 5, confirmed: 5, moved: 0, unconfirmed: 0, rangesDropped: 0 },
        pagesRead: 22,
        skipped: [],
        topics: [
          topic("t1", "Entstehung eines Vertrags", 0.55, "Antrag, Annahme und Form sind die Grundlage für alle Fallbeispiele in der Prüfung.", "Ohne dieses Thema lassen sich die Fälle nicht lösen.", [0, 1], [["read", 142, 149, "7.1 Vertragsabschluss", 30], ["solve", 150, ["1", "2", "5"], 35], ["quiz", 5, 15]], "m1"),
          topic("t2", "Vertragsmängel und Anfechtung", 0.45, "Irrtum, Täuschung und Drohung kommen fast immer als Fall vor.", "Etwa die Hälfte der Fallaufgaben.", [2, 3], [["read", 156, 161, "7.3 Mängel des Vertrags", 25], ["solve", 162, ["3", "4"], 30], ["quiz", 5, 15]], "m1"),
        ],
      },
      ...empty(),
      done: {
        "t1/r0": { date: inDays(-3), minutes: 30, at: 1 },
        "t1/s0": { date: inDays(-2), minutes: 35, at: 2 },
        "t1/q": { date: inDays(-1), minutes: 15, at: 3 },
      },
      mastery: { t1: 0.8 },
      attempts: { t1: 1 },
      history: [{ date: inDays(-1), kind: "topic", topicId: "t1", points: 8, max: 10 }],
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

module.exports = { exams };
