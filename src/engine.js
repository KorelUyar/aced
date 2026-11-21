// From material to strategy, quizzes and corrections. Text is read locally; the model only
// ever gets what a step needs: first the table of contents to find the pages, then those pages.
const files = require("./files");
const ai = require("./ai");
const P = require("./prompts");

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

const SOURCE_CHARS = 220000; // pages of books and other material sent for the strategy (about 65k tokens)
const SMALL_SOURCE = 30000; // a source this small is sent whole
const OBJECTIVE_CHARS = 30000;
const QUIZ_CHARS = 90000;
const tokens = (chars) => Math.ceil(chars / 3.3);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ------------------------------------------------------------ material as text

/** What can be used: sources (books, slides, notes, old exams) numbered from 1, and the objectives. */
function gather(exam) {
  const usable = exam.materials.filter((m) => !m.scanned).map((m) => ({ m, data: files.readText(m.hash) })).filter((x) => x.data);
  const sources = usable.filter((x) => x.m.kind !== "objectives").map((x, i) => ({ ...x, n: i + 1 }));
  const objectives = usable.filter((x) => x.m.kind === "objectives").map((x) => x.data.pages.join("\n")).join("\n\n").slice(0, OBJECTIVE_CHARS);
  return { sources, objectives, scanned: exam.materials.filter((m) => m.scanned) };
}

const KIND_WORDS = { book: "book", slides: "slides", notes: "notes", oldExam: "old exam" };

/** `selection`: Map(source number -> sorted page numbers). */
function pagesBlock(sources, selection) {
  const parts = [];
  for (const s of sources) {
    const pages = selection.get(s.n);
    if (!pages || !pages.length) continue;
    const body = pages.map((p) => `[[book ${s.n}, page ${p}]]\n${s.data.pages[p - 1]}`).join("\n\n");
    parts.push(`<book n="${s.n}" kind="${KIND_WORDS[s.m.kind] || "book"}" title=${JSON.stringify(s.m.title)} pages="${s.m.pages}">\n${body}\n</book>`);
  }
  return parts.join("\n\n");
}

function outlineBlock(s) {
  const lines =
    s.data.outline.length >= 5
      ? s.data.outline.map((o) => `${"  ".repeat(o.depth)}page ${o.page}: ${o.title}`)
      : s.data.pages.map((text, i) => `page ${i + 1}: ${(text.split("\n").find((l) => l.trim()) || "").trim().slice(0, 90)}`);
  return `<book n="${s.n}" kind="${KIND_WORDS[s.m.kind] || "book"}" title=${JSON.stringify(s.m.title)} pages="${s.m.pages}">\n${lines.join("\n")}\n</book>`;
}

const material = (objectives, body) =>
  `<material>\n${objectives ? `<objectives>\n${objectives}\n</objectives>\n\n` : ""}${body}\n</material>`;

const allPages = (s) => Array.from({ length: s.data.pages.length }, (_, i) => i + 1);
const charsOf = (s, pages) => pages.reduce((sum, p) => sum + s.data.pages[p - 1].length, 0);

/** Sources small enough go in whole; the others need the "find the pages" step. */
function split(sources) {
  const total = sources.reduce((sum, s) => sum + s.m.chars, 0);
  if (total <= SOURCE_CHARS) return { whole: sources, large: [], budget: 0 };
  const whole = sources.filter((s) => s.m.chars <= SMALL_SOURCE);
  const large = sources.filter((s) => s.m.chars > SMALL_SOURCE);
  const budget = Math.max(40000, SOURCE_CHARS - whole.reduce((sum, s) => sum + s.m.chars, 0));
  return { whole, large, budget };
}

// ------------------------------------------------------------ estimate

function estimate(exam) {
  const g = gather(exam);
  // Learning objectives alone are not enough: there must be something to read and cite.
  const blocked = g.sources.length ? null : g.scanned.length ? "scanned" : "noMaterial";
  const { whole, large, budget } = split(g.sources);
  const locateChars = large.length ? large.reduce((sum, s) => sum + outlineBlock(s).length, 0) + g.objectives.length : 0;
  const strategyChars = whole.reduce((sum, s) => sum + s.m.chars, 0) + (large.length ? budget : 0) + g.objectives.length;
  const calls = large.length ? 2 : 1;
  return {
    blocked,
    input: tokens(locateChars + strategyChars + calls * (P.SYSTEM.length + 2500)),
    // The answer itself is small; the model's own thinking is billed as output too.
    output: 9000 + (large.length ? 2000 : 0),
    finds: large.length > 0,
    sources: g.sources.length,
    scanned: g.scanned.map((m) => m.title),
    noObjectives: !g.objectives,
  };
}

// ------------------------------------------------------------ checking references against the book

/**
 * 2: the label stands on this page the way an exercise number does (at the start of a line, or
 * followed by a full stop or bracket: "7.", "7 .", "12 a)"); 1: it appears somewhere; 0: not there.
 */
function findLabel(text, label) {
  const core = String(label).trim().replace(/^(aufgabe|übung|uebung|exercise|problem|beispiel|nr\.?|no\.?|ex\.?)\s*/i, "").replace(/[.):]+$/, "");
  if (!core || !text) return 0;
  const esc = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const numbered = new RegExp(`(^|[^0-9A-Za-z.,])(?:(?:aufgabe|übung|exercise|problem|beispiel|nr\\.?)[ \\t]*)?${esc}[ \\t]*(?:[.):]|\\n|$)`, "i");
  const lineStart = new RegExp(`(^|\\n)[ \\t]*(?:(?:aufgabe|übung|exercise|problem|beispiel|nr\\.?)[ \\t]*)?${esc}[ \\t]`, "i");
  if (numbered.test(text) || lineStart.test(text)) return 2;
  return new RegExp(`(^|[^0-9A-Za-z])${esc}(?![0-9A-Za-z])`, "i").test(text) ? 1 : 0;
}

/** Where the exercise really is: the cited page, a neighbour, or nowhere we can see. */
function checkExercise(source, page, label) {
  const text = (p) => source.data.pages[p - 1] || "";
  const here = findLabel(text(page), label);
  if (here === 2) return { page, state: "confirmed" };
  for (const d of [1, -1, 2, -2]) {
    const p = page + d;
    if (p >= 1 && p <= source.data.pages.length && findLabel(text(p), label) === 2) return { page: p, state: "moved" };
  }
  return { page, state: "unconfirmed" };
}

// ------------------------------------------------------------ strategy

async function analyze(exam, { today, daysLeft, minutesTotal, minutesPerDay }, { onProgress, onUsage, signal } = {}) {
  const g = gather(exam);
  if (!g.sources.length) throw coded(g.scanned.length ? "scanned" : "noMaterial");
  const { whole, large, budget } = split(g.sources);
  const selection = new Map(whole.map((s) => [s.n, allPages(s)]));

  if (large.length) {
    onProgress?.({ stage: "locate" });
    const perPage = large.reduce((sum, s) => sum + s.m.chars, 0) / large.reduce((sum, s) => sum + s.m.pages, 0);
    const pageBudget = Math.max(8, Math.floor(budget / perPage));
    const found = await ai.ask(
      {
        name: "pages",
        system: P.SYSTEM,
        material: material(g.objectives, large.map(outlineBlock).join("\n\n")),
        prompt: P.locateTask({ exam, pageBudget }),
        schema: P.LOCATE,
        maxTokens: 8000,
        effort: "medium",
      },
      { signal, onUsage },
    );
    let room = budget;
    for (const r of found.ranges) {
      const s = large.find((x) => x.n === r.book);
      if (!s) continue;
      const from = clamp(Math.min(r.from, r.to), 1, s.m.pages);
      // One page more at the end: exercise sections tend to run on.
      const to = clamp(Math.max(r.from, r.to) + 1, 1, s.m.pages);
      const have = new Set(selection.get(s.n) || []);
      for (let p = from; p <= to; p++) {
        const size = s.data.pages[p - 1].length;
        if (have.has(p) || size > room) continue;
        have.add(p);
        room -= size;
      }
      selection.set(s.n, [...have].sort((a, b) => a - b));
    }
    if (![...selection.values()].some((pages) => pages.length)) throw coded("noPages");
  }

  onProgress?.({ stage: "strategy" });
  const raw = await ai.ask(
    {
      name: "strategy",
      system: P.SYSTEM,
      material: material(g.objectives, pagesBlock(g.sources, selection)),
      prompt: P.strategyTask({ exam, daysLeft, minutesTotal, minutesPerDay }),
      schema: P.STRATEGY,
      maxTokens: 32000,
      effort: "high",
    },
    { signal, onUsage },
  );

  onProgress?.({ stage: "check" });
  const checks = { exercises: 0, confirmed: 0, moved: 0, unconfirmed: 0, rangesDropped: 0 };
  const bySource = new Map(g.sources.map((s) => [s.n, s]));
  const shown = (n, p) => (selection.get(n) || []).includes(p);
  const topics = raw.topics.map((t, i) => {
    const id = "t" + (i + 1);
    const steps = [];
    t.theory.forEach((r) => {
      const s = bySource.get(r.book);
      const from = Math.min(r.from, r.to);
      const to = Math.max(r.from, r.to);
      // A page the model was never shown is a guess: it does not go into the plan.
      if (!s || !shown(r.book, from) || !shown(r.book, to)) return void checks.rangesDropped++;
      steps.push({ id: `${id}/r${steps.length}`, kind: "read", material: s.m.id, from, to, chapter: r.chapter.trim().slice(0, 120), minutes: clamp(r.minutes, 3, 120) });
    });
    const solve = new Map();
    for (const e of t.exercises) {
      const s = bySource.get(e.book);
      if (!s || e.page < 1 || e.page > s.m.pages) {
        checks.rangesDropped++;
        continue;
      }
      checks.exercises++;
      const found = checkExercise(s, e.page, e.label);
      checks[found.state]++;
      const key = s.m.id + ":" + found.page;
      if (!solve.has(key)) solve.set(key, { kind: "solve", material: s.m.id, page: found.page, labels: [], minutes: 0, unconfirmed: [] });
      const step = solve.get(key);
      const label = e.label.trim().slice(0, 20);
      step.labels.push(label);
      step.minutes += clamp(e.minutes, 2, 60);
      if (found.state === "unconfirmed") step.unconfirmed.push(label);
    }
    [...solve.values()].forEach((step, k) => steps.push({ id: `${id}/s${k}`, ...step }));
    const questions = clamp(t.quiz_questions, 3, 6);
    steps.push({ id: `${id}/q`, kind: "quiz", questions, minutes: Math.max(5, Math.round((questions * 2.5) / 5) * 5) });
    const firstPage = steps.find((s) => s.kind === "read")?.from ?? steps.find((s) => s.kind === "solve")?.page ?? 9999;
    return {
      id,
      title: t.title.trim().slice(0, 140),
      why: t.why.trim(),
      skipCost: t.skip_cost.trim(),
      share: clamp(t.share, 0.01, 1),
      objectives: [...new Set(t.objectives.filter((n) => n >= 0 && n < raw.objectives.length))],
      order: firstPage,
      steps,
    };
  });
  if (!topics.length) throw coded("badOutput", "no topics");
  const weight = topics.reduce((sum, t) => sum + t.share, 0);
  for (const t of topics) t.share = Math.round((t.share / weight) * 1000) / 1000;

  return {
    createdOn: today,
    model: ai.config().model,
    approach: raw.approach.trim(),
    objectives: raw.objectives.map((o) => o.trim()).filter(Boolean),
    objectivesGuessed: !g.objectives,
    topics,
    checks,
    pagesRead: [...selection.values()].reduce((sum, pages) => sum + pages.length, 0),
    skipped: g.scanned.map((m) => m.title),
  };
}

// ------------------------------------------------------------ quizzes

/** The pages a topic's quiz is written from: what it tells the student to read and solve. */
function topicPages(exam, topics, sources, extraKinds = []) {
  const byId = new Map(sources.map((s) => [s.m.id, s]));
  const selection = new Map();
  const add = (s, p) => {
    if (!s || p < 1 || p > s.m.pages) return;
    if (!selection.has(s.n)) selection.set(s.n, new Set());
    selection.get(s.n).add(p);
  };
  for (const t of topics) {
    for (const step of t.steps) {
      const s = byId.get(step.material);
      if (step.kind === "read") for (let p = step.from; p <= step.to; p++) add(s, p);
      if (step.kind === "solve") add(s, step.page);
    }
  }
  for (const s of sources) if (extraKinds.includes(s.m.kind) && s.m.chars <= SMALL_SOURCE) allPages(s).forEach((p) => add(s, p));
  // Keep within the budget, page by page in book order.
  let room = QUIZ_CHARS;
  const out = new Map();
  for (const s of sources) {
    const pages = [...(selection.get(s.n) || [])].sort((a, b) => a - b).filter((p) => {
      const size = s.data.pages[p - 1].length;
      if (size > room) return false;
      room -= size;
      return true;
    });
    if (pages.length) out.set(s.n, pages);
  }
  return out;
}

async function writeQuiz(exam, { key, topicIds, count, mock = false, variant = 0 }, { onUsage, signal } = {}) {
  const g = gather(exam);
  const topics = exam.strategy.topics.filter((t) => topicIds.includes(t.id));
  if (!topics.length) throw coded("badOutput", "no topic");
  const selection = topicPages(exam, topics, g.sources, mock ? ["oldExam"] : []);
  const names = topics.map((t) => ({ title: t.title, objectives: t.objectives.map((n) => exam.strategy.objectives[n]).filter(Boolean) }));
  const hasOldExam = g.sources.some((s) => s.m.kind === "oldExam" && selection.has(s.n));
  const raw = await ai.ask(
    {
      name: "questions",
      system: P.SYSTEM,
      material: material("", pagesBlock(g.sources, selection)),
      prompt: P.quizTask({ topics: names, count, mock, hasOldExam }) + (variant ? `\nThis is set number ${variant + 1} for the same material: ask about other aspects than a first set would.` : ""),
      schema: P.QUESTIONS,
      maxTokens: 24000,
      effort: "medium",
    },
    { signal, onUsage },
  );
  const bySource = new Map(g.sources.map((s) => [s.n, s]));
  const questions = raw.questions.map((q, i) => {
    const topic = topics[clamp(q.topic, 0, topics.length - 1)];
    const choices = q.type === "choice" ? q.choices.filter((c) => c.trim()) : [];
    const isChoice = choices.length >= 2 && q.correct >= 0 && q.correct < choices.length;
    const source = bySource.get(q.book);
    const cited = source && (selection.get(q.book) || []).includes(q.page);
    const fallback = topic.steps.find((s) => s.kind === "read");
    return {
      id: `${key}/k${i}`,
      topicId: topic.id,
      type: isChoice ? "choice" : q.type === "open" ? "open" : "short",
      prompt: q.prompt.trim(),
      ...(isChoice ? { choices, correct: q.correct } : {}),
      answer: q.answer.trim(),
      rubric: q.rubric.trim(),
      explain: q.explain.trim(),
      points: clamp(q.points, 1, 4),
      // Only a page that was really in front of the model is offered as "open the book here".
      material: cited ? source.m.id : fallback ? fallback.material : null,
      page: cited ? q.page : fallback ? fallback.from : null,
    };
  });
  if (!questions.length) throw coded("badOutput", "no questions");
  return { key, variant, questions };
}

/** Corrects one answer. Multiple choice is checked here; written answers go to the model. */
async function grade(question, answer, { onUsage, signal } = {}) {
  if (question.type === "choice") {
    const right = answer === question.correct;
    return { points: right ? question.points : 0, feedback: question.explain, correct: right ? "" : question.choices[question.correct] };
  }
  const raw = await ai.ask(
    {
      name: "correction",
      system: P.SYSTEM,
      prompt: P.gradeTask({ question, answer: String(answer).slice(0, 6000) }),
      schema: P.GRADE,
      maxTokens: 6000,
      effort: "medium",
    },
    { signal, onUsage },
  );
  const points = clamp(raw.points, 0, question.points);
  return { points, feedback: raw.feedback.trim(), correct: points < question.points ? raw.correct_answer.trim() : "" };
}

module.exports = { estimate, analyze, writeQuiz, grade, findLabel, checkExercise, gather };
