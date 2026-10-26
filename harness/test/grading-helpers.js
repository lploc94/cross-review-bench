// Grading tests: judges answered from the prompt, so tests do not depend on the seeded finding order.

/** The findings a judge or dedupe prompt shows. */
export function promptFindings(prompt) {
  const m = prompt.match(/## Findings[\s\S]*?```json\n([\s\S]*?)\n```/);
  return JSON.parse(m[1]);
}

/**
 * An `invoke` for judgeSet/judgeTask/poolSet whose judge answers rule(finding, judge, prompt) →
 * { matches, valid } for each finding (by its title); `calls` records every call.
 */
export function ruleInvoke(rule, calls = []) {
  return async (judge, { prompt }) => {
    calls.push({ judge: judge.name, model: judge.model, prompt });
    const judgments = promptFindings(prompt).map(f => ({ id: f.id, reason: "test", ...rule(f, judge, prompt) }));
    return { status: "completed", text: JSON.stringify({ judgments }) };
  };
}
