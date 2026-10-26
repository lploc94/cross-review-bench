# Track C: cells

Fixed rate: bugs whose hidden tests pass, bootstrap CI over loops; regression: visible tests fail, Wilson CI.

| orchestrator | cell | loops | fixed_rate | fixed_lo | fixed_hi | regression_rate | regression_lo | regression_hi | mean_review_rounds | median_wall_s |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | agy | 40 | 0.895 | 0.797 | 0.979 | 0.025 | 0.004 | 0.129 | 1.975 | 492.000 |
| claude | claude | 34 | 0.913 | 0.830 | 0.979 | 0.000 | 0.000 | 0.102 | 1.941 | 277.000 |
| claude | codex | 39 | 0.929 | 0.860 | 0.983 | 0.000 | 0.000 | 0.090 | 2.103 | 330.000 |
| claude | none | 40 | 0.947 | 0.887 | 1.000 | 0.000 | 0.000 | 0.088 | 0.000 | 176.000 |
| codex | agy | 40 | 0.877 | 0.797 | 0.949 | 0.000 | 0.000 | 0.088 | 1.425 | 423.500 |
| codex | claude | 36 | 0.885 | 0.800 | 0.961 | 0.028 | 0.005 | 0.142 | 1.833 | 274.500 |
| codex | codex | 39 | 0.873 | 0.784 | 0.947 | 0.026 | 0.005 | 0.132 | 3.077 | 375.000 |
| codex | none | 40 | 0.877 | 0.796 | 0.948 | 0.000 | 0.000 | 0.088 | 0.000 | 226.500 |
