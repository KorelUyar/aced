// From material to strategy, formula sheet, exam questions and answers to the student's own
// questions. Text is read locally; the model only ever gets what a step needs: first the table
// of contents to find the pages, then those pages.
const files = require("./files");
const ai = require("./ai");
const P = require("./prompts");
const search = require("./search");
const answers = require("./answers");

const coded = (code, detail) => Object.assign(new Error(code), { code, detail });

const SOURCE_CHARS = 220000; // pages of books and other material sent for the strategy (about 65k tokens)
const SMALL_SOURCE = 30000; // a source this small is sent whole
const OBJECTIVE_CHARS = 30000;
const QUIZ_CHARS = 90000; // pages a set of questions is written from
const HELP_CHARS = 60000; // pages sent with one question to the helper
const OUTLINE_CHARS = 30000; // tables of contents sent with it
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

// Of the pages it may ask for from a large book, a model takes well under half (30% in the
// real runs so far). The estimate says what to expect and what it can be at most.
const EXPECTED_PICK = 0.4;

function estimate(exam) {
  const g = gather(exam);
  // Learning objectives alone are not enough: there must be something to read and cite.
  const blocked = g.sources.length ? null : g.scanned.length ? "scanned" : "noMaterial";
  const { whole, large, budget } = split(g.sources);
  const calls = large.length ? 2 : 1;
  const fixed = whole.reduce((sum, s) => sum + s.m.chars, 0) + g.objectives.length + calls * (P.SYSTEM.length + 2500);
  const locateChars = large.length ? large.reduce((sum, s) => sum + outlineBlock(s).length, 0) + g.objectives.length : 0;
  return {
    blocked,
    input: tokens(fixed + locateChars + (large.length ? budget * EXPECTED_PICK : 0)),
    inputMax: tokens(fixed + locateChars + (large.length ? budget : 0)),
    // The formula sheet is written right after, from the same pages (read a second time).
    again: tokens(whole.reduce((sum, s) => sum + s.m.chars, 0) + g.objectives.length + (large.length ? budget * EXPECTED_PICK : 0)),
    // The answers themselves are small; the model's own thinking is billed as output too.
    output: (large.length ? 5000 : 4000) + 3000,
    finds: large.length > 0,
    sources: g.sources.length,
    scanned: g.scanned.map((m) => m.title),
    noObjectives: !g.objectives,
  };
}

// ------------------------------------------------------------ checking references against the book

/**
 * 2: the label stands on this page the way an exercise number does: at the start of a line or
 * of a column, or right after another numbered item ("5. 6. 7."), and followed by a full stop
 * or a bracket, or with the word for exercise in front of it. 1: it appears somewhere, for
 * example at the end of a sentence ("a pH of 2."). 0: not there.
 *
 * `recognised`: the text was read from pictures of the pages (see ocr.js). There a "1." can
 * come out as "l." or "i.", a "5." as "S.", and a number at the start of a column can lose its
 * full stop. Such a reading also counts as 2, but only between its neighbours: when a number
 * just below it stands earlier on the page as an exercise number, or one just above it later,
 * and neither of the two next to it stands on the wrong side. A line that happens to start
 * with "S." or "I." is not taken for an exercise on its own, and neither is part "i)" of
 * exercise 2.
 */
function findLabel(text, label, recognised = false) {
  const core = String(label).trim().replace(/^(aufgabe|übung|uebung|exercise|problem|nr\.?|no\.?|ex\.?)\s*/i, "").replace(/[.):]+$/, "");
  if (!core || !text) return 0;
  const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const word = "(?:aufgabe|übung|uebung|exercise|problem|nr\\.?)";
  /** Where a label first stands the way an exercise number does, or -1. */
  const standsAt = (wanted) => {
    const esc = escaped(wanted);
    const patterns = [
      // "7." or "7)" where a list number can stand
      `(?:^|\\n|[.:;)][ \\t]+|\\t|[ ]{2,})${esc}[ \\t]*[.):]`,
      // alone at the start of a line, with the text of the exercise after it
      `(?:^|\\n)[ \\t]*${esc}(?:[ \\t]|\\n|$)`,
      // "Aufgabe 7", "Exercise 12 a"
      `${word}[ \\t]*${esc}(?![0-9A-Za-z])`,
    ];
    const found = patterns.map((p) => text.search(new RegExp(p, "i"))).filter((i) => i >= 0);
    return found.length ? Math.min(...found) : -1;
  };
  if (standsAt(core) >= 0) return 2;
  // A label with a letter in it ("Ü1", "A3") first on its line, or first in a table row after
  // the row's number (a spreadsheet printed by Aced) or after a "|": a table of exercises.
  if (/\p{L}/u.test(core) && new RegExp(`(?:^|\\|)[ \\t]*(?:\\d{1,5}[ \\t]+)?${escaped(core)}(?=[ \\t|]|$)`, "imu").test(text)) return 2;
  // A part of an exercise ("6 b", "6b"): the exercise stands, and the part's letter after it ("b)", "(b)").
  const part = /^(\d{1,3})\s*\.?\s*([a-z])\)?$/i.exec(core);
  if (part) {
    const at = standsAt(part[1]);
    if (at >= 0 && new RegExp(`(?:^|\\n|[ \\t(])${part[2]}[).]`, "i").test(text.slice(at))) return 2;
  }
  if (recognised && /^\d{1,3}$/.test(core)) {
    const n = Number(core);
    const lookalike = { 0: "[0Oo]", 1: "[1lIi|]", 5: "[5Ss]" };
    const shape = [...core].map((digit) => lookalike[digit] || digit).join("");
    const misread = new RegExp(
      // "l." for "1." at the start of a line or of a column, with words after it (not "S. 45", a page)
      `(?:^|\\n|[ ]{2,})[ \\t]*(${shape})[ \\t]*[.)](?=[ \\t]+[^\\d\\s]|[ \\t]*(?:\\n|$))` +
        // "12 Berechne" at the start of a column: the number without its full stop
        `|[ ]{2,}${core}[ \\t]+(?=\\p{Lu})`,
      "gu",
    );
    const [lower2, lower, higher, higher2] = [n - 2, n - 1, n + 1, n + 2].map((m) => (m > 0 ? standsAt(String(m)) : -1));
    for (const m of text.matchAll(misread)) {
      // "ll." is not taken for an 11: at least one of the digits must have been read as one
      if (m[1] && core.length > 1 && !/\d/.test(m[1])) continue;
      const between = [lower, lower2].some((i) => i >= 0 && i < m.index) || [higher, higher2].some((i) => i > m.index);
      const wrongSide = lower > m.index || (higher >= 0 && higher < m.index);
      if (between && !wrongSide) return 2;
    }
  }
  return new RegExp(`(^|[^0-9A-Za-z])${escaped(core)}(?![0-9A-Za-z])`, "i").test(text) ? 1 : 0;
}

/**
 * Where the exercise really is: the cited page, a neighbour, or nowhere we can see.
 * A model sometimes gives the number printed on the page instead of the page's place in the
 * file; `offset` (file page minus printed page) lets that be put right as well.
 */
function checkExercise(source, page, label, offset = 0) {
  const count = source.data.pages.length;
  const number = /^\d{1,4}$/.test(String(label).trim()) ? Number(label) : 0;
  // A page's own number in its running head or foot is not an exercise. Without this, the
  // page that starts with "12  1 • Prerequisites" is where exercise 12 gets moved to.
  const text = (p) => {
    const lines = (source.data.pages[p - 1] || "").split("\n");
    if (!number || number !== p - offset) return lines.join("\n");
    const filled = lines.flatMap((line, i) => (line.trim() ? [i] : []));
    const edge = new Set([...filled.slice(0, 2), ...filled.slice(-2)]);
    const pageNumber = new RegExp(`^\\s*${number}(?=\\s|$)|(?:^|\\s)${number}\\s*$`);
    return lines.filter((line, i) => !(edge.has(i) && pageNumber.test(line))).join("\n");
  };
  // A book whose text was recognised from pictures gets the looser reading of numbers.
  const stands = (p) => findLabel(text(p), label, Boolean(source.data.recognised)) === 2;
  if (stands(page)) return { page, state: "confirmed" };
  for (const p of [page + 1, page - 1, page + 2, page - 2, ...(offset ? [page + offset, page + offset + 1, page + offset - 1] : [])]) {
    if (p >= 1 && p <= count && stands(p)) return { page: p, state: "moved" };
  }
  return { page, state: "unconfirmed" };
}

// ------------------------------------------------------------ strategy

async function analyze(exam, { today, daysLeft, minutesTotal, minutesPerDay, solved = [] }, { onProgress, onUsage, onKey, signal, fresh } = {}) {
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
        maxTokens: 16000,
        effort: "medium",
        usable: (v) => (v.ranges.length ? "" : "no page ranges"),
      },
      { signal, onUsage, onKey, fresh },
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
      prompt: P.strategyTask({
        exam,
        daysLeft,
        minutesTotal,
        minutesPerDay,
        solved: solved.map((x) => ({ ...x, n: (g.sources.find((src) => src.m.id === x.material) || {}).n })).filter((x) => x.n).map((x) => `book ${x.n} page ${x.page}: ${x.labels.join(", ")}`).join("; "),
      }),
      schema: P.STRATEGY,
      maxTokens: 64000,
      effort: "high",
      // The formula sheet reads the same pages right after: with a key that is cheaper from the provider's cache.
      cache: true,
      usable: (v) => (v.topics.length ? "" : "no topics"),
    },
    { signal, onUsage, onKey, fresh },
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
      const found = checkExercise(s, e.page, e.label, s.m.offset);
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
    // The pages the model was shown, per material: the formula sheet is written from them, and questions fall back on them.
    shown: g.sources.filter((src) => selection.has(src.n)).map((src) => ({ material: src.m.id, pages: selection.get(src.n) })),
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
  // A topic whose page references could not be used (a weak model names pages it never saw)
  // is quizzed from everything the strategy was made from, so the questions stay grounded.
  if (!selection.size) for (const shown of exam.strategy.shown || []) shown.pages.forEach((p) => add(byId.get(shown.material), p));
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

const tidy = (text) => String(text).toLowerCase().replace(/[\s$\\{}]/g, "").replace(/[.;,]+$/, "");

/**
 * Questions with a result that can be typed, for the final exam (`final`, all topics) or for
 * one topic whose book has no exercises. Returns { key, variant, questions, spare }: `spare`
 * holds further book exercises per topic (checked against the page text), for whoever needs
 * more practice after the exam.
 */
async function writeQuestions(exam, { key, topicIds, count, final = false, variant = 0 }, { onUsage, onKey, signal } = {}) {
  const g = gather(exam);
  const topics = exam.strategy.topics.filter((t) => topicIds.includes(t.id));
  if (!topics.length) throw coded("badOutput", "no topic");
  const selection = topicPages(exam, topics, g.sources, final ? ["oldExam"] : []);
  const number = new Map(g.sources.map((s) => [s.m.id, s.n]));
  const solve = (t) => t.steps.filter((s) => s.kind === "solve");
  const planned = topics.map((t) => `- ${t.title}: ` + (solve(t).map((s) => `book ${number.get(s.material)} page ${s.page}: ${s.labels.join(", ")}`).join("; ") || "none")).join("\n");
  const names = topics.map((t) => ({ title: t.title, objectives: t.objectives.map((n) => exam.strategy.objectives[n]).filter(Boolean) }));
  const raw = await ai.ask(
    {
      name: "questions",
      system: P.SYSTEM,
      material: material("", pagesBlock(g.sources, selection)),
      prompt: P.questionsTask({ topics: names, count, final, variant, planned, hasOldExam: g.sources.some((s) => s.m.kind === "oldExam" && selection.has(s.n)) }),
      schema: P.QUESTIONS,
      maxTokens: 48000,
      effort: "medium",
      cache: true,
      usable: (v) => (v.questions.length ? "" : "no questions"),
    },
    { signal, onUsage, onKey },
  );
  const bySource = new Map(g.sources.map((s) => [s.n, s]));
  const questions = raw.questions.map((q, i) => {
    const topic = topics[clamp(q.topic, 0, topics.length - 1)];
    const source = bySource.get(q.book);
    const cited = source && (selection.get(q.book) || []).includes(q.page);
    const fallback = topic.steps.find((s) => s.kind === "read");
    const choices = q.choices.map((c) => c.trim()).filter(Boolean);
    const values = q.values.filter(Number.isFinite);
    // A question whose fields do not fit its type is asked as text: still only for the result.
    let type = q.type;
    if (type === "choice" && !(choices.length >= 2 && q.correct >= 0 && q.correct < choices.length)) type = "text";
    if (type === "numbers" && values.length === 1) type = "number";
    if (type === "numbers" && !values.length) type = "text";
    if (type === "number" && !Number.isFinite(q.type === "numbers" ? values[0] : q.value)) type = "text";
    const value = q.type === "numbers" ? values[0] : q.value;
    const size = type === "number" ? Math.abs(value) : Math.max(0, ...values.map(Math.abs));
    const unit = q.unit.trim().slice(0, 20);
    const answer =
      q.answer.trim() || (type === "number" ? `${answers.show(value)} ${unit}`.trim() : type === "numbers" ? values.map(answers.show).join("; ") : type === "choice" ? choices[q.correct] : "");
    if (type === "text" && !answer) return null;
    return {
      id: `${key}/k${i}`,
      topicId: topic.id,
      type,
      prompt: q.prompt.trim(),
      ...(type === "number" ? { value, unit } : {}),
      ...(type === "numbers" ? { values, unit } : {}),
      // A tolerance wider than a twentieth of the value would let wrong results through.
      ...(type === "number" || type === "numbers" ? { tolerance: clamp(q.tolerance || 0, 0, Math.max(size * 0.05, 0.5)) } : {}),
      ...(type === "choice" ? { choices, correct: q.correct } : {}),
      answer,
      solution: q.solution.trim(),
      points: clamp(q.points, 1, 3),
      // Only a page that was really in front of the model is offered as "open the book here".
      material: cited ? source.m.id : fallback ? fallback.material : null,
      page: cited ? q.page : fallback ? fallback.from : null,
    };
  }).filter(Boolean);
  if (!questions.length) throw coded("badOutput", "no questions");

  const spare = {};
  for (const e of raw.more) {
    const topic = topics[e.topic];
    const s = bySource.get(e.book);
    const label = e.label.trim().slice(0, 20);
    if (!topic || !s || !label || e.page < 1 || e.page > s.m.pages) continue;
    const found = checkExercise(s, e.page, label, s.m.offset);
    if (found.state === "unconfirmed") continue; // only exercises that can be seen on the page
    if (solve(topic).some((st) => st.material === s.m.id && st.labels.includes(label))) continue;
    const list = (spare[topic.id] = spare[topic.id] || []);
    if (list.reduce((sum, x) => sum + x.labels.length, 0) >= 3) continue;
    let step = list.find((x) => x.material === s.m.id && x.page === found.page);
    if (!step) list.push((step = { material: s.m.id, page: found.page, labels: [], minutes: 0 }));
    if (!step.labels.includes(label)) {
      step.labels.push(label);
      step.minutes += clamp(e.minutes, 2, 60);
    }
  }
  return { key, final, variant, topicIds: topics.map((t) => t.id), questions, spare };
}

/**
 * Marks what was typed. A choice is decided here. A number, or a set of numbers, that this Mac
 * reads as the expected one is right, at once and for certain. Everything else goes to the
 * model in one request, told to look at the result only: results that are not numbers, and
 * numbers this Mac could not match, because "wrong" from a comparison of notations is not
 * certain enough to cost someone a topic. Returns { [question id]: { points, max, note, by } },
 * `by` saying who decided ("here" or "model").
 */
async function mark(questions, typed, { onUsage, onKey, signal } = {}) {
  const out = {};
  const open = [];
  for (const q of questions) {
    const given = typed[q.id];
    const text = typeof given === "string" ? given.trim() : "";
    let right = null;
    if (q.type === "choice") right = given === q.correct;
    else if (!text) right = false;
    else if (q.type === "number") right = answers.numberRight(text, q.value, q.tolerance) || null;
    else if (q.type === "numbers") right = answers.numbersRight(text, q.values, q.tolerance) || null;
    else if (tidy(text) === tidy(q.answer)) right = true;
    if (right === null) open.push({ n: open.length, q, text: text.slice(0, 2000) });
    else out[q.id] = { points: right ? q.points : 0, max: q.points, note: "", by: "here" };
  }
  if (open.length) {
    const raw = await ai.ask(
      {
        name: "marks",
        system: P.SYSTEM,
        prompt: P.gradeTask({ items: open.map((x) => ({ n: x.n, points: x.q.points, prompt: x.q.prompt, answer: x.q.answer, typed: x.text })) }),
        schema: P.GRADE,
        maxTokens: 16000,
        effort: "medium",
        usable: (v) => (open.every((x) => v.results.some((r) => r.n === x.n)) ? "" : "a result is missing"),
      },
      { signal, onUsage, onKey },
    );
    for (const x of open) {
      const r = raw.results.find((y) => y.n === x.n);
      const points = clamp(r.points, 0, x.q.points);
      out[x.q.id] = { points, max: x.q.points, note: points < x.q.points ? r.note.trim() : "", by: "model" };
    }
  }
  return out;
}

// ------------------------------------------------------------ formula sheet and helper

/** The pages the strategy was made from, as material: what the formula sheet is written from. */
function shownMaterial(exam, limit) {
  const g = gather(exam);
  const byId = new Map(g.sources.map((s) => [s.m.id, s]));
  const selection = new Map();
  let room = limit;
  for (const shown of exam.strategy.shown || []) {
    const s = byId.get(shown.material);
    if (!s) continue;
    const pages = shown.pages.filter((p) => {
      const size = (s.data.pages[p - 1] || "").length;
      if (p < 1 || p > s.m.pages || size > room) return false;
      room -= size;
      return true;
    });
    if (pages.length) selection.set(s.n, pages);
  }
  // An exam from before "shown" was kept: fall back on the pages its steps name.
  if (!selection.size) for (const [n, pages] of topicPages(exam, exam.strategy.topics, g.sources)) selection.set(n, pages);
  return { g, selection, text: material(g.objectives, pagesBlock(g.sources, selection)) };
}

/**
 * The formulas this exam needs, per topic, each with the page it stands on:
 * [{ topicId, formulas: [{ name, latex, note, material, page }] }].
 */
async function writeFormulas(exam, { onUsage, onKey, signal } = {}) {
  const topics = exam.strategy.topics;
  // The same pages, in the same order, as the strategy read: a provider that caches has them already.
  const { g, selection, text } = shownMaterial(exam, SOURCE_CHARS);
  const bySource = new Map(g.sources.map((s) => [s.n, s]));
  const raw = await ai.ask(
    { name: "formulas", system: P.SYSTEM, material: text, prompt: P.formulasTask({ exam, topics }), schema: P.FORMULAS, maxTokens: 32000, effort: "medium", cache: true },
    { signal, onUsage, onKey },
  );
  return raw.groups
    .filter((group) => topics[group.topic] && group.formulas.length)
    .map((group) => ({
      topicId: topics[group.topic].id,
      formulas: group.formulas.slice(0, 8).map((f) => {
        // Only a page that was really in front of the model becomes a link.
        const seen = bySource.get(f.book) && (selection.get(f.book) || []).includes(f.page);
        return { name: f.name.trim(), latex: f.latex.trim().replace(/^\$+|\$+$/g, ""), note: f.note.trim(), material: seen ? bySource.get(f.book).m.id : null, page: seen ? f.page : null };
      }),
    }));
}

/** A long table of contents, thinned out evenly until it fits. */
function fitted(block, limit) {
  if (block.length <= limit) return block;
  const lines = block.split("\n");
  const keep = Math.max(1, Math.ceil(block.length / limit));
  return lines.filter((line, i) => i === 0 || i === lines.length - 1 || i % keep === 0).join("\n");
}

/**
 * An answer to a question about this exam, with the pages it points to:
 * { answer, pages: [{ material, page, what }] }. The pages for the question are picked here,
 * by a search through the whole text of every book; only those are sent.
 * `earlier`: the last questions and answers of the conversation, `now`: the step that is up.
 */
async function help(exam, question, { earlier = [], now = "" } = {}, { onUsage, onKey, signal } = {}) {
  const g = gather(exam);
  const asked = String(question).slice(0, 1000);
  const bySource = new Map(g.sources.map((s) => [s.n, s]));
  const number = new Map(g.sources.map((s) => [s.m.id, s.n]));
  const topics = exam.strategy.topics;
  const plan = topics
    .map((t) => `- ${t.title}: ` + t.steps.filter((s) => s.kind !== "quiz").map((s) => (s.kind === "read" ? `read book ${number.get(s.material)} pages ${s.from}-${s.to}` : `solve book ${number.get(s.material)} page ${s.page}: ${s.labels.join(", ")}`)).join("; "))
    .join("\n");

  // The pages: the best matches in the whole text, the page after each of the best three
  // (sections run on), and the pages of a topic the question names.
  const wanted = [];
  const want = (n, page) => {
    const s = bySource.get(n);
    if (s && page >= 1 && page <= s.m.pages && !wanted.some((w) => w.n === n && w.page === page)) wanted.push({ n, page });
  };
  const hits = search.rank(g.sources.map((s) => ({ n: s.n, hash: s.m.hash, pages: s.data.pages })), [asked, ...earlier.slice(-1).map((e) => e.question)].join(" "), 10);
  hits.slice(0, 3).forEach((h) => (want(h.n, h.page), want(h.n, h.page + 1)));
  const askedWords = new Set(search.words(asked));
  for (const t of topics) {
    const title = search.words(t.title);
    if (!title.length || title.filter((w) => askedWords.has(w)).length < Math.min(2, title.length)) continue;
    for (const st of t.steps) if (st.kind === "solve") want(number.get(st.material), st.page);
    for (const st of t.steps) if (st.kind === "read") want(number.get(st.material), st.from);
  }
  hits.forEach((h) => want(h.n, h.page));
  const selection = new Map();
  let room = HELP_CHARS;
  for (const w of wanted) {
    const size = bySource.get(w.n).data.pages[w.page - 1].length;
    if (size > room) continue;
    room -= size;
    selection.set(w.n, [...(selection.get(w.n) || []), w.page].sort((a, b) => a - b));
  }

  const stable = material(g.objectives, g.sources.map((s) => fitted(outlineBlock(s), OUTLINE_CHARS / g.sources.length)).join("\n\n") + `\n\n<plan>\n${plan}\n</plan>`);
  const raw = await ai.ask(
    {
      name: "help",
      system: P.SYSTEM,
      // Objectives, tables of contents and plan stay the same from question to question: a provider that caches reads them once.
      material: stable,
      prompt: P.helpTask({
        exam,
        question: asked,
        pages: pagesBlock(g.sources, selection),
        now,
        earlier: earlier.slice(-3).map((e) => `Student: ${String(e.question).slice(0, 300)}\nAnswer: ${String(e.answer).slice(0, 600)}`).join("\n"),
      }),
      schema: P.HELP,
      maxTokens: 16000,
      effort: "low",
      cache: true,
    },
    { signal, onUsage, onKey },
  );
  // A page may be linked when it was sent, or when a table of contents or the plan names it.
  const known = (n, page) => {
    const s = bySource.get(n);
    if (!s || page < 1 || page > s.m.pages) return false;
    if ((selection.get(n) || []).includes(page) || s.data.outline.some((o) => o.page === page)) return true;
    return topics.some((t) => t.steps.some((st) => number.get(st.material) === n && (st.kind === "solve" ? st.page === page : st.kind === "read" && page >= st.from && page <= st.to)));
  };
  return {
    answer: raw.answer.trim(),
    pages: raw.pages
      .filter((p) => known(p.book, p.page))
      .slice(0, 6)
      .map((p) => ({ material: bySource.get(p.book).m.id, page: p.page, what: p.what.trim().slice(0, 60) })),
    searched: [...selection.values()].reduce((sum, pages) => sum + pages.length, 0),
  };
}

module.exports = { estimate, analyze, writeQuestions, mark, writeFormulas, help, findLabel, checkExercise, gather };
