// The plan, worked out locally from the strategy: which task goes on which day, what does not
// fit, how far along the person is. No AI and no clock in here: every function gets `today`
// (YYYY-MM-DD), so the same input always gives the same plan, and a plan re-forms by itself
// when the person falls behind, does more, or a quiz shows a weak topic.
//
// What it draws on from learning research: retrieval practice (every topic ends in a quiz, and
// the quiz comes a day after the exercises where there is a day), spaced repetition (missed
// questions come back after 1, 2, 4 and 7 days), interleaving (a review mixes topics), and a
// mock exam near the end.

const DAY = 86400000;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const round5 = (x) => Math.max(5, Math.round(x / 5) * 5);

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

// ------------------------------------------------------------ where the person stands

/** How well a topic is expected to go, 0..1: from quizzes if there are any, else from the work done. */
function topicMastery(exam, topic) {
  const measured = exam.mastery && exam.mastery[topic.id];
  if (typeof measured === "number") return measured;
  const work = topic.steps.filter((s) => s.kind !== "quiz");
  const done = work.filter((s) => exam.done && exam.done[s.id]).length;
  return 0.15 + 0.35 * (work.length ? done / work.length : 0);
}

/**
 * Readiness: how much of what the target grade needs is secured today.
 * Projected grade: where the person lands if they finish the plan. Topics still ahead are
 * assumed to go reasonably well (80%), quizzed topics count as measured (with a little credit
 * for the repetition still to come), dropped topics count as they stand. An estimate, and
 * labelled as one.
 */
function standing(exam, plan) {
  const topics = exam.strategy ? exam.strategy.topics : [];
  if (!topics.length) return { readiness: 0, projected: null, quizzed: false };
  const weight = topics.reduce((sum, t) => sum + t.share, 0) || 1;
  const dropped = new Set(plan ? plan.dropped.map((d) => d.topicId) : []);
  let now = 0;
  let atExam = 0;
  for (const t of topics) {
    const current = topicMastery(exam, t);
    const measured = exam.mastery && exam.mastery[t.id];
    const later = dropped.has(t.id) ? current : typeof measured === "number" ? measured + (0.85 - measured) * 0.4 : 0.8;
    now += (t.share / weight) * current;
    atExam += (t.share / weight) * Math.max(current, later);
  }
  const need = targetScore(exam.scale, exam.target) || 1;
  return { readiness: clamp(now / need), projected: gradeFor(exam.scale, atExam), quizzed: Object.keys(exam.mastery || {}).length > 0 };
}

// ------------------------------------------------------------ spaced repetition

const INTERVALS = [1, 2, 4, 7];

/** The card of a question after an answer worth `ratio` (0..1) of its points. */
function nextCard(card, ratio, today) {
  if (ratio >= 0.999) {
    // Right: the next look is further away each time (2, 4, 7 days), then the question rests.
    const box = Math.min(INTERVALS.length - 1, (card ? card.box : 0) + 1);
    return { box, due: addDays(today, INTERVALS[box]) };
  }
  // Missed or half right: back to the start. Half right gets one more day.
  return { box: 0, due: addDays(today, ratio >= 0.5 ? 2 : 1) };
}

/** Questions due for review today, topics mixed. */
function dueQuestions(exam, today, limit = 10) {
  const byTopic = new Map();
  for (const [topicId, quiz] of Object.entries(exam.quizzes || {})) {
    for (const q of quiz.questions || []) {
      const card = exam.cards && exam.cards[q.id];
      if (!card || card.due > today || card.box >= INTERVALS.length - 1) continue;
      const key = q.topicId || topicId;
      if (!byTopic.has(key)) byTopic.set(key, []);
      byTopic.get(key).push(q);
    }
  }
  const lists = [...byTopic.values()];
  const out = [];
  for (let i = 0; out.length < limit && lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i] && out.length < limit) out.push(l[i]);
  }
  return out;
}

// ------------------------------------------------------------ the plan

const minutesOf = (steps) => steps.reduce((sum, s) => sum + s.minutes, 0);

function buildPlan(exam, today) {
  const s = exam.strategy;
  if (!s) return null;
  const done = exam.done || {};
  const daysLeft = Math.max(0, diffDays(today, exam.date));
  // Study days: today up to the day before the exam (on the exam day itself, only today).
  const dates = Array.from({ length: Math.max(1, daysLeft) }, (_, i) => addDays(today, i));

  const doneToday = Object.entries(done).filter(([, d]) => d.date === today);
  const spentToday = doneToday.reduce((sum, [, d]) => sum + (d.minutes || 0), 0);
  const spentBefore = Object.values(done).reduce((sum, d) => sum + (d.date < today ? d.minutes || 0 : 0), 0);
  const perDay =
    exam.time.mode === "perDay" ? exam.time.minutes : round5(Math.max(10, (exam.time.minutes - spentBefore) / dates.length));
  const bonus = exam.bonus && exam.bonus.date === today ? exam.bonus.minutes : 0;
  const left = dates.map((_, i) => (i === 0 ? Math.max(0, perDay + bonus - spentToday) : perDay));
  const totalLeft = left.reduce((a, b) => a + b, 0);

  const days = dates.map((date, i) => ({ date, minutes: i === 0 ? perDay + bonus : perDay, tasks: [] }));
  const taskOf = (topic, step, extra) => ({
    id: step.id,
    kind: step.kind,
    topicId: topic ? topic.id : null,
    title: topic ? topic.title : "",
    step,
    minutes: step.minutes,
    done: Boolean(done[step.id]),
    ...extra,
  });

  // What is already done today stays visible, in the order it was done.
  const stepIndex = new Map();
  for (const t of s.topics) for (const step of t.steps) stepIndex.set(step.id, [t, step]);
  for (const [id, d] of doneToday.sort((a, b) => (a[1].at || 0) - (b[1].at || 0))) {
    const hit = stepIndex.get(id);
    if (hit) days[0].tasks.push(taskOf(hit[0], hit[1]));
    else if (id.startsWith("review:")) days[0].tasks.push({ id, kind: "review", title: "", step: { kind: "review" }, minutes: d.minutes, done: true });
    else if (id === "mock") days[0].tasks.push({ id, kind: "mock", title: "", step: { kind: "mock" }, minutes: d.minutes, done: true });
  }

  const place = (from, task, force) => {
    for (let i = Math.min(from, days.length - 1); i < days.length; i++) {
      const fresh = left[i] >= days[i].minutes && !days[i].tasks.some((t) => !t.done);
      if (left[i] >= task.minutes * 0.6 || (fresh && left[i] > 0) || (force && i === days.length - 1)) {
        days[i].tasks.push(task);
        left[i] -= task.minutes;
        return i;
      }
    }
    return -1;
  };

  // Due questions first: a short mixed review today.
  const due = dueQuestions(exam, today);
  if (due.length && !done["review:" + today]) {
    const minutes = clamp(due.length * 2, 5, 15);
    place(0, { id: "review:" + today, kind: "review", title: "", step: { kind: "review", questions: due.length }, minutes, done: false }, true);
  }

  // A mock exam on the last study day, when there is more than one day and more than one topic,
  // and only if no topic has to be dropped for it: covering the exam comes first.
  const mockWish = s.topics.length >= 2 && dates.length >= 2 && !done.mock ? clamp(round5(perDay * 0.6), 20, 45) : 0;
  const reviewReserve = Math.round(totalLeft * (exam.pace === "thorough" ? 0.15 : 0.08));

  // Which topics, in which order. Value per minute decides, except when there is time for
  // everything in the book's own order.
  const density = (t) => t.share / Math.max(5, minutesOf(t.steps));
  const byValue = [...s.topics].sort((a, b) => density(b) - density(a));
  const need = targetScore(exam.scale, exam.target);
  let room = totalLeft - reviewReserve;
  let covered = 0;
  const chosen = [];
  const dropped = [];
  for (const t of byValue) {
    const open = t.steps.filter((st) => !done[st.id]);
    const remaining = minutesOf(open);
    const started = open.length < t.steps.length;
    if (remaining === 0) {
      chosen.push(t);
      covered += t.share;
    } else if (exam.pace === "efficient" && !started && covered * 0.85 >= need) {
      dropped.push({ topicId: t.id, title: t.title, minutes: remaining, share: t.share, reason: "notNeeded", note: t.skipCost || "" });
    } else if (remaining <= room || started) {
      chosen.push(t);
      room -= remaining;
      covered += t.share;
    } else {
      dropped.push({ topicId: t.id, title: t.title, minutes: remaining, share: t.share, reason: "time", note: t.skipCost || "" });
    }
  }
  const mockMinutes = mockWish && (room >= mockWish || !dropped.some((d) => d.reason === "time")) ? mockWish : 0;
  const ordered = exam.pace === "thorough" && !dropped.length ? [...chosen].sort((a, b) => a.order - b.order) : chosen;

  let cursor = 0;
  const quizDay = new Map(); // topic id -> day (0 = today, negative = days ago) of its first quiz
  for (const t of ordered) {
    let last = cursor;
    for (const step of t.steps) {
      if (done[step.id]) {
        if (step.kind === "quiz") quizDay.set(t.id, diffDays(today, done[step.id].date));
        continue;
      }
      // The quiz comes a day after the exercises where there is a day: recalling after a
      // night's sleep teaches more than recalling right away.
      const from = step.kind === "quiz" && t.steps.some((x) => x.kind !== "quiz" && !done[x.id]) ? last + 1 : cursor;
      const at = place(from, taskOf(t, step), true);
      if (step.kind === "quiz") quizDay.set(t.id, at);
      else {
        last = at;
        cursor = at;
      }
    }
    // A weak quiz result brings the topic's quiz back two days later (at most twice).
    const attempts = (exam.attempts && exam.attempts[t.id]) || 0;
    const weak = typeof (exam.mastery || {})[t.id] === "number" && exam.mastery[t.id] < 0.6;
    const quizStep = t.steps.find((x) => x.kind === "quiz");
    if (weak && quizStep && done[quizStep.id] && attempts < 3) {
      const againId = `${quizStep.id}#${attempts}`;
      if (!done[againId]) {
        const from = Math.max(0, diffDays(today, addDays(done[quizStep.id].date, 2)));
        place(from, taskOf(t, { ...quizStep, id: againId, again: true }), true);
      }
    }
  }

  // Time left over goes into repetition: each topic's quiz again with new questions, three
  // and seven days after the first one. With the thorough pace this is the point; with the
  // others it only happens when nothing had to be dropped.
  if (exam.pace === "thorough" || !dropped.some((d) => d.reason === "time")) {
    for (const gap of [3, 7]) {
      for (const t of ordered) {
        const quizStep = t.steps.find((x) => x.kind === "quiz");
        if (!quizStep || !quizDay.has(t.id)) continue;
        const id = `${quizStep.id}~${gap}`;
        const at = quizDay.get(t.id) + gap;
        if (done[id] || at >= days.length) continue;
        const from = Math.max(0, at);
        if (left[from] >= quizStep.minutes) place(from, taskOf(t, { ...quizStep, id, again: true }), false);
      }
    }
  }

  if (mockMinutes) {
    days[days.length - 1].tasks.push({ id: "mock", kind: "mock", title: "", step: { kind: "mock" }, minutes: mockMinutes, done: false });
  }

  const planned = days.reduce((sum, d) => sum + d.tasks.filter((t) => !t.done).reduce((m, t) => m + t.minutes, 0), 0);
  const droppedShare = dropped.reduce((sum, d) => sum + d.share, 0);
  const weight = s.topics.reduce((sum, t) => sum + t.share, 0) || 1;
  const coverage = clamp((weight - droppedShare) / weight);
  return {
    computedOn: today,
    daysLeft,
    perDay,
    available: totalLeft,
    planned,
    coverage,
    // The honest part: the best grade this plan can reach if everything in it goes well, and
    // how much more time the dropped topics would take.
    reach: gradeFor(exam.scale, coverage),
    reachable: coverage + 0.001 >= need,
    short: dropped.filter((d) => d.reason === "time").reduce((sum, d) => sum + d.minutes, 0),
    days,
    dropped,
  };
}

module.exports = { buildPlan, standing, topicMastery, nextCard, dueQuestions, targetScore, gradeFor, addDays, diffDays, todayIso };
