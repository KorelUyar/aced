// The book's exercises as tasks in the app: is a typed result right, and what follows from it.
// Only the final result is typed (a number, several numbers, a choice or an expression): the
// working is done on paper.
const answers = require("./answers");
const expr = require("./expr");
const planner = require("./planner");

/** Every task of an exam's plan, with its topic. */
const allTasks = (exam) => (exam.strategy ? exam.strategy.topics.flatMap((t) => (t.tasks || []).map((task) => ({ task, topic: t }))) : []);

/** Whether `typed` is the result of `task`. A choice is its position; everything else is text. */
function isRight(task, typed) {
  if (task.type === "choice") return Number.isInteger(typed) && typed === task.correct;
  const text = typeof typed === "string" ? typed.trim().slice(0, 400) : "";
  if (!text) return false;
  const tolerance = task.tolerance || 0;
  if (task.type === "number") {
    if (answers.numberRight(text, task.value, tolerance)) return true;
    // "3/4", "sqrt(2)/2": worked out here, never run as code.
    const v = expr.value(text.split("=").pop());
    return Number.isFinite(v) && Math.abs(v - task.value) <= Math.max(tolerance, Math.abs(task.value) * 1e-6, 1e-12);
  }
  if (task.type === "numbers") return task.ordered ? answers.numbersInOrder(text, task.values, tolerance) : answers.numbersRight(text, task.values, tolerance);
  if (task.type === "expression") return expr.same(text, task.expression);
  return false;
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
  const right = isRight(task, typed);
  // A task whose result could not be confirmed never counts as wrong: it says so instead.
  const sure = task.checked !== "none";
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
  return { right, sure };
}

module.exports = { isRight, answer, allTasks };
