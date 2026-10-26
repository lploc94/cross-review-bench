Several code reviews of one pull request reported the findings below. Each was judged a real defect, but none of them is a defect the maintainers already know about. Group the findings that describe the same underlying defect, so each group can be checked once.

Your working directory is the repository with the pull request applied as uncommitted changes (`git diff` shows the pull request). Read whatever code you need. Do not modify, create or delete any file, and do not read anything outside the working directory.

## The pull request

Title: {{TITLE}}

{{DESCRIPTION}}

## Findings

```json
{{FINDINGS}}
```

## How to group

- Two findings belong together when fixing one defect in the code would resolve both; the same lines with different problems are different defects.
- Every finding id appears in exactly one group; a finding unlike the others is a group of its own.
- For each group give the defect's main location (`file`, repository-relative, and `lines` as `[first, last]` of the faulty code), a `severity` (`critical`, `high`, `medium` or `low`: critical = money lost or created, data corrupted or leaked, authentication bypassed, service down for everyone; high = a main path wrong for some inputs, lost writes, unbounded growth; medium = an edge case wrong, an error swallowed or misreported, a noticeable slowdown on a common path; low = harmless detail) and a one-sentence `summary` of the defect.

## Answer

Reply with exactly one JSON object and nothing else:

```json
{"groups": [{"findings": ["F1", "F4"], "file": "src/a.ts", "lines": [10, 14], "severity": "medium", "summary": "..."}]}
```
