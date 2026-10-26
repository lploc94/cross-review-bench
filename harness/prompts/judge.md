You are a judge grading the findings of several code reviews of one pull request. You are not a reviewer: do not look for new problems. For each finding listed below, decide whether it describes a real defect and which known issue, if any, it is about.

Your working directory is the repository with the pull request applied as uncommitted changes (`git diff` shows the pull request). Read whatever code you need. Do not modify, create or delete any file, and do not read anything outside the working directory.

## The pull request

Title: {{TITLE}}

{{DESCRIPTION}}

## Answer key

{{ANSWER_KEY}}

## Workspace states

{{STATES}}

## Findings

Each finding was raised against the workspace state named in its `state` field. Findings are in no particular order and come from different reviews; several may describe the same problem.

```json
{{FINDINGS}}
```

## How to judge a finding

- `matches`: the ids of answer-key items the finding is about — the same underlying defect (for a decoy: the same code it suspects), even when its location, wording or severity differ. A finding may match several items, or none. A different problem in the same lines does not match. For a finding raised against a state with a change applied, match a bug when the finding says that bug is still present, that the change does not fix it, or that the change introduces a defect while fixing it.
{{MATCH_SCOPE}}- `valid`: `"real"` when the finding describes a real defect in the code of its state that this pull request introduces or that the changed code relies on — a competent maintainer would fix it before merging. `"not_real"` when its claim is wrong, when it is not a defect (style, naming, preference, a speculative risk with no concrete failure), when the defect is outside this pull request, or when it is about a decoy. A finding that only says tests are missing or would not catch a case is `"not_real"` unless it names a concrete defect in the code, which is then what you judge; a defect in a test or document the pull request adds (a test that hangs or asserts the wrong thing, documentation that misstates the change) is `"real"`. `"uncertain"` only when you cannot decide after reading the code.
- A finding that matches a decoy is `"not_real"`.
- Judge the substance; severity labels and writing style do not matter.
- `reason`: one or two sentences citing the code.

## Answer

Reply with exactly one JSON object and nothing else, with one entry per finding id:

```json
{"judgments": [{"id": "F1", "matches": ["B1"], "valid": "real", "reason": "..."}]}
```
