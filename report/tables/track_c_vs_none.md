# Track C: each review cell minus no review

Fixed rate (fixed / testable bugs) of the cell minus that of no review, over the tasks both ran; bootstrap CI resampling those tasks in pairs.

| orchestrator | cell | tasks | diff_vs_none | lo | hi |
|---|---|---|---|---|---|
| claude | agy | 40 | -0.053 | -0.151 | 0.020 |
| claude | claude | 34 | -0.043 | -0.116 | 0.000 |
| claude | codex | 39 | -0.018 | -0.102 | 0.056 |
| codex | agy | 40 | 0.000 | 0.000 | 0.000 |
| codex | claude | 36 | 0.019 | -0.064 | 0.103 |
| codex | codex | 39 | 0.000 | -0.056 | 0.050 |
