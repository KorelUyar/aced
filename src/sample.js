// Invented exams for `--sample`: what the app looks like once the engine has done its work.
// The texts are German on purpose. Plans, quizzes and feedback follow the language of the
// material, not the language of the interface. Nothing in this file comes from a real book.

function inDays(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function exams() {
  return [
    {
      id: "sample-math",
      name: "Mathematik: Quadratische Funktionen",
      date: inDays(6),
      time: { mode: "perDay", minutes: 45 },
      scale: "ch",
      target: 5,
      pace: "sprint",
      createdAt: inDays(-2) + "T16:00:00.000Z",
      readiness: 0.58,
      projected: 4.5,
      materials: [
        { id: "m1", kind: "book", title: "Mathematik 1: Algebra und Funktionen", pages: 312 },
        { id: "m2", kind: "objectives", title: "Lernziele Semesterprüfung", count: 9 },
        { id: "m3", kind: "oldExam", title: "Prüfung 2025, Serie A", pages: 6 },
      ],
      strategy: {
        availableMinutes: 270,
        plannedMinutes: 260,
        objectives: 9,
        summary:
          "Die Zeit reicht für die vier Themen, die zusammen etwa 85% der Punkte ausmachen. Zwei Themen fallen weg. Das kostet dich im schlechtesten Fall eine halbe Note.",
        topics: [
          {
            id: "t1",
            title: "Scheitelpunktform und Parabel zeichnen",
            priority: "core",
            minutes: 60,
            share: 0.3,
            objectives: 3,
            why: "Kam in der Prüfung 2025 in 3 von 9 Aufgaben vor. Wer die Scheitelpunktform sicher kann, löst auch die Textaufgaben schneller.",
            steps: [
              { kind: "read", chapter: "4.2", from: 88, to: 91, minutes: 15 },
              { kind: "solve", page: 92, numbers: [4, 5, 7], minutes: 20 },
              { kind: "solve", page: 93, numbers: [11], minutes: 15 },
              { kind: "quiz", questions: 3, minutes: 10 },
            ],
          },
          {
            id: "t2",
            title: "Nullstellen mit der Mitternachtsformel",
            priority: "core",
            minutes: 50,
            share: 0.25,
            objectives: 2,
            why: "Reine Übungssache und fast sichere Punkte. Drei Aufgaben reichen, um die Formel fehlerfrei anzuwenden.",
            steps: [
              { kind: "read", chapter: "4.4", from: 96, to: 98, minutes: 15 },
              { kind: "solve", page: 99, numbers: [2, 3, 6], minutes: 25 },
              { kind: "quiz", questions: 4, minutes: 10 },
            ],
          },
          {
            id: "t3",
            title: "Textaufgaben mit quadratischen Gleichungen",
            priority: "core",
            minutes: 45,
            share: 0.2,
            objectives: 2,
            why: "Gibt viele Punkte pro Aufgabe. Übe das Aufstellen der Gleichung, das Rechnen kannst du dann schon.",
            steps: [
              { kind: "read", chapter: "4.6", from: 104, to: 105, minutes: 10 },
              { kind: "solve", page: 106, numbers: [1, 4], minutes: 20 },
              { kind: "solve", page: 107, numbers: [8], minutes: 15 },
            ],
          },
          {
            id: "t4",
            title: "Diskriminante und Anzahl Lösungen",
            priority: "worth",
            minutes: 30,
            share: 0.1,
            objectives: 1,
            why: "Kurzes Thema, das auf der Mitternachtsformel aufbaut. Zwei Aufgaben genügen.",
            steps: [
              { kind: "read", chapter: "4.4", from: 98, to: 98, minutes: 10 },
              { kind: "solve", page: 100, numbers: [12, 13], minutes: 20 },
            ],
          },
        ],
        dropped: [
          {
            title: "Schnittpunkte von Parabel und Gerade",
            minutes: 40,
            share: 0.1,
            why: "Steht in einem Lernziel, braucht aber 40 min für etwa 10% der Punkte. Wenn du früher fertig bist, kommt es zurück in den Plan.",
          },
          {
            title: "Satz von Vieta",
            minutes: 35,
            share: 0.05,
            why: "Steht im Buch, aber in keinem deiner Lernziele, und kam in der alten Prüfung nicht vor.",
          },
        ],
      },
      today: {
        day: 3,
        days: 8,
        tomorrow: "Nullstellen mit der Mitternachtsformel",
        tasks: [
          {
            id: "a1",
            kind: "read",
            title: "Scheitelpunktform und Parabel zeichnen",
            step: { kind: "read", chapter: "4.2", from: 88, to: 91 },
            minutes: 15,
            done: true,
          },
          {
            id: "a2",
            kind: "solve",
            title: "Scheitelpunktform und Parabel zeichnen",
            step: { kind: "solve", page: 92, numbers: [4, 5, 7] },
            minutes: 20,
            why: "Bringt für eine 5.0 am meisten Punkte pro Minute. Die Theorie dazu hast du vorhin gelesen, jetzt sitzt sie am besten.",
            done: false,
          },
          {
            id: "a3",
            kind: "quiz",
            title: "Scheitelpunktform",
            step: { kind: "quiz", questions: 3 },
            minutes: 10,
            why: "Drei Fragen ohne Buch. Sich selbst abzufragen bringt mehr, als die Seiten nochmals zu lesen.",
            done: false,
          },
        ],
      },
      quiz: {
        title: "Scheitelpunktform",
        questions: [
          {
            id: "q1",
            type: "choice",
            prompt: "Welchen Scheitelpunkt hat die Parabel f(x) = (x − 3)² + 2?",
            points: 1,
            choices: ["S(3 | 2)", "S(−3 | 2)", "S(3 | −2)", "S(2 | 3)"],
            correct: 0,
            explain:
              "In der Scheitelpunktform f(x) = a(x − d)² + e liegt der Scheitelpunkt bei S(d | e). Das Vorzeichen in der Klammer dreht sich um: aus (x − 3) wird d = 3.",
            page: 89,
          },
          {
            id: "q2",
            type: "short",
            prompt: "Bringe f(x) = x² − 6x + 5 in die Scheitelpunktform und gib den Scheitelpunkt an.",
            points: 3,
            sampleAnswer: "f(x) = (x − 3)² + 4, also S(3 | 4)",
            // Stands in for the AI correction until the engine exists.
            sampleFeedback: {
              verdict: "partly",
              points: 2,
              text: "Die quadratische Ergänzung mit (x − 3)² stimmt. Beim Ausgleichen ist dir das Vorzeichen verrutscht: −9 + 5 ergibt −4, nicht +4.",
              correct: "f(x) = (x − 3)² − 4, Scheitelpunkt S(3 | −4)",
              backInDays: 2,
            },
            page: 90,
          },
          {
            id: "q3",
            type: "choice",
            prompt: "Wie sieht die Parabel f(x) = −2(x + 1)² + 3 im Vergleich zur Normalparabel aus?",
            points: 1,
            choices: [
              "Nach unten geöffnet und schmaler",
              "Nach unten geöffnet und breiter",
              "Nach oben geöffnet und schmaler",
              "Nach oben geöffnet und breiter",
            ],
            correct: 0,
            explain:
              "a = −2: Das Minus öffnet die Parabel nach unten, und weil der Betrag grösser als 1 ist, wird sie schmaler.",
            page: 88,
          },
        ],
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
      readiness: 0.31,
      projected: 4,
      materials: [
        { id: "m1", kind: "book", title: "Recht und Gesellschaft", pages: 268 },
        { id: "m2", kind: "objectives", title: "Lernziele Vertragsrecht", count: 12 },
      ],
      strategy: {
        availableMinutes: 390,
        plannedMinutes: 360,
        objectives: 12,
        summary: "Die Zeit reicht für alle zwölf Lernziele, mit einer Wiederholung vor der Prüfung. Nichts fällt weg.",
        topics: [
          {
            id: "t1",
            title: "Entstehung eines Vertrags",
            priority: "core",
            minutes: 80,
            share: 0.35,
            objectives: 4,
            why: "Antrag, Annahme und Form sind die Grundlage für alle Fallbeispiele in der Prüfung.",
            steps: [
              { kind: "read", chapter: "7.1", from: 142, to: 149, minutes: 30 },
              { kind: "solve", page: 150, numbers: [1, 2, 5], minutes: 35 },
              { kind: "quiz", questions: 6, minutes: 15 },
            ],
          },
          {
            id: "t2",
            title: "Vertragsmängel und Anfechtung",
            priority: "core",
            minutes: 70,
            share: 0.25,
            objectives: 3,
            why: "Irrtum, Täuschung und Drohung kommen fast immer als Fall vor.",
            steps: [
              { kind: "read", chapter: "7.3", from: 156, to: 161, minutes: 25 },
              { kind: "solve", page: 162, numbers: [3, 4], minutes: 30 },
              { kind: "quiz", questions: 6, minutes: 15 },
            ],
          },
        ],
        dropped: [],
      },
      today: {
        day: 5,
        days: 17,
        tomorrow: "Vertragsmängel und Anfechtung",
        tasks: [
          {
            id: "b1",
            kind: "read",
            title: "Entstehung eines Vertrags",
            step: { kind: "read", chapter: "7.1", from: 142, to: 149 },
            minutes: 30,
            why: "Der Einstieg ins Thema. Lies mit den Lernzielen daneben und markiere, was du nicht in eigenen Worten erklären kannst.",
            done: false,
          },
        ],
      },
      quiz: null,
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
      readiness: 0,
      projected: null,
      materials: [],
      strategy: null,
      today: null,
      quiz: null,
    },
  ];
}

module.exports = { exams };
