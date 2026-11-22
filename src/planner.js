// The plan, worked out locally from the strategy: one ordered list of steps (read these pages,
// solve these exercises), what does not fit into the time, how much of it is done, and what
// is for today. No AI and no clock in here: every function gets `today` (YYYY-MM-DD), so
// the same input always gives the same plan, and the plan re-forms by itself when the person
// falls behind or gets ahead.
//
// What decides: value per minute decides what is left out when time is short. What stays is
// done in the book's own order, because a later chapter leans on the earlier one.

// A step is ticked off only by an entry of its own: never by a name every object has
// ("constructor", "toString"), which a plan from somewhere else could use as a step's id.
const tickOf = (done, id) => (done && Object.prototype.hasOwnProperty.call(done, id) ? done[id] : undefined);

const DAY = 86400000;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}
const diffDays = (from, to) => Math.round((new Date(to + "T12:00:00") - new Date(from + "T12:00:00")) / DAY);
function todayIso(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

// ------------------------------------------------------------ grades

/** The share of the points a grade stands for, 0..1. */
function targetScore(scale, target) {
  if (scale === "pct") return clamp(target / 100);
  if (scale === "de") return clamp(1 - (target - 1) * 0.16); // 1 = 100%, 4 = 52%
  return clamp((target - 1) / 5); // Swiss: grade = 1 + 5 x share of points
}

function gradeFor(scale, score) {
  const s = clamp(score);
  if (scale === "pct") return Math.round(s * 100);
  const grade = scale === "de" ? 1 + (1 - s) / 0.16 : 1 + 5 * s;
  return clamp(Math.round(grade * 2) / 2, 1, 6);
}

/** Is `grade` at least as good as `target` on this scale? */
const reaches = (scale, grade, target) => (scale === "de" ? grade <= target : grade >= target);

// ------------------------------------------------------------ the plan

const minutesOf = (steps) => steps.reduce((sum, s) => sum + s.minutes, 0);

const SUMMARY_MINUTES = 3;
const PAGE_MINUTES = 4; // reading one page that matters, slowly

/**
 * The steps of a topic that go on the list. A topic with a summary starts with it (about three
 * minutes, instead of its pages). Then, by pace:
 * - "efficient": the summary, the exercises, then a short check (three questions on the topic).
 *   No reading: the pages stay a link in the summary.
 * - "sprint": the summary and the exercises; questions only where the book has no exercises.
 * - "thorough": the summary, then only the pages it names as the ones that matter, the exercises
 *   and the check.
 * A step that was ticked off stays on the list whatever the pace: done work is never taken away.
 * A topic without a summary (an exam from before Aced 0.6, until it has one) keeps its steps:
 * what to read, which exercises to solve, and questions where the book has no exercises.
 */
function workOf(topic, pace = "thorough", done = {}) {
  const ticked = (st) => Boolean(tickOf(done, st.id));
  const reads = topic.steps.filter((s) => s.kind === "read");
  const solve = topic.steps.filter((s) => s.kind === "solve");
  const quiz = topic.steps.find((s) => s.kind === "quiz");
  if (!topic.summary) return [...reads, ...solve, ...(quiz && !solve.length ? [quiz] : [])];
  const summary = { id: `${topic.id}/sum`, kind: "summary", minutes: SUMMARY_MINUTES };
  let reading = reads.filter(ticked);
  if (pace === "thorough") {
    const key = topic.summary.pages || [];
    reading =
      reading.length || !key.length
        ? reads
        : key.map((r, i) => ({ id: `${topic.id}/k${i}`, kind: "read", material: r.material, from: r.from, to: r.to, chapter: r.what || "", minutes: Math.max(3, (r.to - r.from + 1) * PAGE_MINUTES), key: true }));
  }
  const short = pace === "efficient" && solve.length && !ticked(quiz) ? { ...quiz, questions: Math.min(quiz.questions || 4, 3), minutes: 6 } : quiz;
  const check = quiz && (pace !== "sprint" || !solve.length || ticked(quiz)) ? [short] : [];
  return [summary, ...reading, ...solve, ...check];
}

function buildPlan(exam, today) {
  const s = exam.strategy;
  if (!s) return null;
  const done = exam.done || {};
  const daysLeft = diffDays(today, exam.date);
  const over = daysLeft < 0;
  // Study days: today up to the day before the exam (on the exam day itself, only today).
  const dates = Array.from({ length: Math.max(1, daysLeft) }, (_, i) => addDays(today, i));

  const spentToday = Object.values(done).reduce((sum, d) => sum + (d.date === today ? d.minutes || 0 : 0), 0);
  const spentBefore = Object.values(done).reduce((sum, d) => sum + (d.date < today ? d.minutes || 0 : 0), 0);
  // Time "in total" is shared out over the days that are left, to the minute: 60 minutes over
  // 14 days is 60 minutes, not 14 times a rounded-up share.
  const total = exam.time.mode === "total" ? Math.max(0, exam.time.minutes - spentBefore) : exam.time.minutes * dates.length;
  const base = Math.floor(total / dates.length);
  const budget = dates.map((_, i) => base + (i < total - base * dates.length ? 1 : 0));
  const left = budget.map((m, i) => (i === 0 ? Math.max(0, m - spentToday) : m));
  const totalLeft = left.reduce((a, b) => a + b, 0);

  // What stays and what is left out.
  const density = (t) => t.share / Math.max(5, minutesOf(workOf(t, exam.pace, done)));
  const need = targetScore(exam.scale, exam.target);
  let room = totalLeft;
  let covered = 0;
  const kept = new Set();
  const dropped = [];
  for (const t of [...s.topics].sort((a, b) => density(b) - density(a))) {
    const work = workOf(t, exam.pace, done);
    const open = work.filter((st) => !tickOf(done, st.id));
    const remaining = minutesOf(open);
    const started = open.length < work.length;
    if (remaining === 0) {
      kept.add(t.id);
      covered += t.share;
    } else if (exam.pace === "efficient" && !started && covered * 0.85 >= need) {
      dropped.push({ topicId: t.id, title: t.title, minutes: remaining, share: t.share, reason: "notNeeded", note: t.skipCost || "" });
    } else if (remaining <= room || started) {
      kept.add(t.id);
      room -= remaining;
      covered += t.share;
    } else {
      dropped.push({ topicId: t.id, title: t.title, minutes: remaining, share: t.share, reason: "time", note: t.skipCost || "" });
    }
  }

  // The list: topics in the book's order, then whatever an exam result put back on it.
  const byId = new Map(s.topics.map((t) => [t.id, t]));
  const task = (topic, step, again) => ({
    id: step.id,
    kind: step.kind,
    topicId: topic ? topic.id : null,
    step,
    minutes: step.minutes,
    done: Boolean(tickOf(done, step.id)),
    doneOn: tickOf(done, step.id) ? tickOf(done, step.id).date : null,
    again,
    today: false,
  });
  const stages = [];
  const ordered = s.topics.map((t, i) => ({ t, i })).filter((x) => kept.has(x.t.id)).sort((a, b) => (a.t.order ?? 9999) - (b.t.order ?? 9999) || a.i - b.i);
  for (const { t } of ordered) stages.push({ id: t.id, topicId: t.id, title: t.title, again: false, tasks: workOf(t, exam.pace, done).map((step) => task(t, step, false)) });
  for (const a of exam.again || []) {
    const t = byId.get(a.topicId);
    if (t && a.steps.length) stages.push({ id: a.id, topicId: t.id, title: t.title, again: true, score: a.score ?? null, tasks: a.steps.map((step) => task(t, step, true)) });
  }
  const tasks = stages.flatMap((stage) => stage.tasks);

  // Which day each open step falls on: in order, a day is full when the next step would
  // overrun it by more than a little. The last day takes what is left.
  const days = dates.map((date, i) => ({ date, minutes: budget[i], tasks: [] }));
  days[0].tasks.push(...tasks.filter((t) => t.doneOn === today));
  let at = 0;
  for (const t of tasks) {
    if (t.done) continue;
    const fits = (i) => left[i] >= t.minutes * 0.6 || (left[i] > 0 && !days[i].tasks.some((x) => !x.done));
    while (at < days.length - 1 && !fits(at)) at++;
    days[at].tasks.push(t);
    left[at] -= t.minutes;
  }
  if (!over) for (const t of days[0].tasks) if (!t.done) t.today = true;

  const open = tasks.filter((t) => !t.done);
  const allMinutes = minutesOf(tasks) || 1;
  // A step whose tasks are partly right in the app counts for that part.
  const results = exam.taskResults || {};
  const ofStep = (t) => (s.topics.find((x) => x.id === t.topicId)?.tasks || []).filter((x) => (t.step.tasks ? t.step.tasks.includes(x.id) : x.step === t.id));
  const partly = (t) => {
    const list = t.kind === "solve" ? ofStep(t) : [];
    return list.length ? (list.filter((x) => (tickOf(results, x.id) || {}).right).length / list.length) * t.minutes : 0;
  };
  const openMinutes = open.reduce((sum, t) => sum + t.minutes - partly(t), 0);
  const weight = s.topics.reduce((sum, t) => sum + t.share, 0) || 1;
  const coverage = clamp((weight - dropped.reduce((sum, d) => sum + d.share, 0)) / weight);
  const todayOpen = open.filter((t) => t.today);
  return {
    computedOn: today,
    daysLeft: Math.max(0, daysLeft),
    over,
    perDay: Math.round(total / dates.length),
    available: totalLeft,
    planned: minutesOf(open),
    // How much of the plan is done, by minutes: a long exercise set counts for more than a short page.
    // An exam from before Aced 0.6 got summaries and other steps: until the next tick, it shows
    // no less than it did (`floor`), so the new steps never look like lost progress.
    percent: tasks.length && !open.length ? 100 : Math.min(99, Math.max(exam.floor || 0, Math.round(((allMinutes - openMinutes) / allMinutes) * 100))),
    next: open.length ? open[0].id : null,
    today: { steps: todayOpen.length, minutes: minutesOf(todayOpen), end: todayOpen.length && todayOpen.length < open.length ? todayOpen[todayOpen.length - 1].id : null },
    coverage,
    // The honest part: the best grade this plan can reach if everything in it goes well.
    reach: gradeFor(exam.scale, coverage),
    // Compared as grades, the way they are shown: 78% and 80% of the points are both a 5.0.
    reachable: reaches(exam.scale, gradeFor(exam.scale, coverage), exam.target),
    short: dropped.filter((d) => d.reason === "time").reduce((sum, d) => sum + d.minutes, 0),
    stages,
    days,
    dropped,
  };
}

module.exports = {
  tickOf, buildPlan, workOf, targetScore, gradeFor, reaches, addDays, diffDays, todayIso };
