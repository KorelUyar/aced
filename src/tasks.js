// The book's exercises as tasks in the app: is a typed result right, and what follows from it.
// Only the final result is typed (a number, several numbers, a choice or an expression): the
// working is done on paper.
const answers = require("./answers");
const expr = require("./expr");
const planner = require("./planner");

/** Every task of an exam's plan, with its topic. */
const allTasks = (exam) => (exam.strategy ? exam.strategy.topics.flatMap((t) => (t.tasks || []).map((task) => ({ task, topic: t }))) : []);

// Two answers where one is asked for: "4 oder 5", "3 bis 5", "1, 2, 3", "±4".
const HEDGED = /±|\+\/-|\+-|\d\s*(?:;|\||\boder\b|\bor\b|\bund\b|\band\b|\bbis\b|\bto\b|,\s)\s*[-−+]?\d/i;

/**
 * What a typed result is, for `task`: { verdict } with "right", "wrong" (only when the app is
 * sure), "ask" (the writing allows another reading that would be right, or it names two results
 * where one is asked for: `suggest` holds the reading with brackets, or `one` is true) or
 * "unsure" (the app cannot tell: the solution is shown and the person judges).
 */
function check(task, typed) {
  if (task.type === "choice") return { verdict: Number.isInteger(typed) && typed === task.correct ? "right" : "wrong" };
  const text = typeof typed === "string" ? typed.trim().slice(0, 400) : "";
  if (!text) return { verdict: "wrong" };
  const tolerance = task.tolerance || 0;
  const near = (v) => Number.isFinite(v) && Math.abs(v - task.value) <= Math.max(tolerance, Math.abs(task.value) * 1e-6, 1e-12);
  if (task.type === "number") {
    if (HEDGED.test(text)) return { verdict: "ask", one: true };
    if (answers.numberRight(text, task.value, tolerance)) return { verdict: "right" };
    // "3/4", "sqrt(2)/2": worked out here, never run as code.
    if (near(expr.value(text.split("=").pop()))) return { verdict: "right" };
    const other = expr.alternatives(text).find((alt) => near(expr.value(alt)));
    return other ? { verdict: "ask", suggest: other } : { verdict: "wrong" };
  }
  if (task.type === "numbers") {
    const right = task.ordered ? answers.numbersInOrder(text, task.values, tolerance) : answers.numbersRight(text, task.values, tolerance);
    return { verdict: right ? "right" : "wrong" };
  }
  if (task.type === "expression") {
    const same = expr.compare(text, task.expression);
    if (same === true) return { verdict: "right" };
    const other = expr.alternatives(text).find((alt) => expr.compare(alt, task.expression) === true);
    if (other) return { verdict: "ask", suggest: other };
    return { verdict: same === null ? "unsure" : "wrong" };
  }
  return { verdict: "unsure" };
}

/** true (right), false (wrong) or null (a question back, or the app cannot tell). */
function isRight(task, typed) {
  const { verdict } = check(task, typed);
  return verdict === "right" ? true : verdict === "wrong" ? false : null;
}

/**
 * Takes a typed result into the exam (`e`, changed in place): the task's tries, whether it is
 * right, the step ticked off when all its tasks are right, and a task that was wrong comes back
 * once more at the end of the plan. Returns whether it was right.
 */
function answer(e, taskId, typed, today) {
  const found = allTasks(e).find((x) => x.task.id === taskId);
  if (!found) return null;
  const { task, topic } = found;
  const judged = check(task, typed);
  // A question back ("did you mean 1/(2x)?") counts for nothing yet.
  if (judged.verdict === "ask") return { right: false, sure: false, verdict: "ask", suggest: judged.suggest || null, one: Boolean(judged.one) };
  const right = judged.verdict === "right";
  // A task whose solution could not be confirmed, or a result the app cannot judge, never counts
  // as wrong: the solution is shown, and the person judges.
  const sure = task.checked !== "none" && judged.verdict !== "unsure";
  e.taskResults = e.taskResults || {};
  const before = planner.tickOf(e.taskResults, taskId) || { tries: 0, wrong: 0 };
  const now = { ...before, tries: before.tries + 1, right, date: today, at: Date.now() };
  if (!right && sure) now.wrong = (before.wrong || 0) + 1;
  if (!sure) now.seen = true;
  e.taskResults[taskId] = now;
  const step = topic.steps.find((st) => st.id === task.step);
  const ofStep = (topic.tasks || []).filter((x) => x.step === task.step && x.type !== "paper");
  const settled = (x) => {
    const r = planner.tickOf(e.taskResults, x.id) || {};
    return r.right || (x.checked === "none" && r.seen);
  };
  if (step && (right || !sure) && ofStep.every(settled) && !planner.tickOf(e.done, step.id)) {
    e.done[step.id] = { date: today, minutes: step.minutes, at: Date.now() };
    delete e.floor;
  }
  // Wrong once: it comes back later, after the rest of the plan.
  const againId = `again:${taskId}`;
  e.again = e.again || [];
  if (!right && sure && !e.again.some((a) => a.id === againId)) {
    e.again.push({ id: againId, topicId: topic.id, from: "task", score: null, steps: [{ id: `${taskId}/again`, kind: "solve", material: task.material, page: task.page, labels: [task.label], minutes: task.minutes || 5, repeat: true, tasks: [taskId] }] });
  }
  // Right on a later try (another day): its repetition is done.
  const back = e.again.find((a) => a.id === againId);
  if (right && back && before.wrong && before.date !== today) e.done[`${taskId}/again`] = { date: today, minutes: task.minutes || 5, at: Date.now() };
  return { right, sure, verdict: right ? "right" : sure ? "wrong" : "unsure" };
}

/** "My result was right": the person's own judgement counts, as in the final exam. */
function overrule(e, taskId, today) {
  const found = allTasks(e).find((x) => x.task.id === taskId);
  if (!found) return false;
  const { task, topic } = found;
  e.taskResults = e.taskResults || {};
  const before = planner.tickOf(e.taskResults, taskId) || { tries: 0, wrong: 0 };
  e.taskResults[taskId] = { ...before, tries: Math.max(1, before.tries), wrong: 0, right: true, own: true, date: today, at: Date.now() };
  e.again = (e.again || []).filter((a) => a.id !== `again:${taskId}`);
  const step = topic.steps.find((st) => st.id === task.step);
  const ofStep = (topic.tasks || []).filter((x) => x.step === task.step && x.type !== "paper");
  const settled = (x) => {
    const r = planner.tickOf(e.taskResults, x.id) || {};
    return r.right || (x.checked === "none" && r.seen);
  };
  if (step && ofStep.every(settled) && !planner.tickOf(e.done, step.id)) e.done[step.id] = { date: today, minutes: step.minutes, at: Date.now() };
  return true;
}

module.exports = { check, isRight, answer, overrule, allTasks };
