# Pairwise tests, config high

Within-task permutation, 10,000 permutations; Holm over 3 pairs per metric; a winner needs Holm-adjusted p < 0.05. MDE: minimum detectable difference at 80% power.

| metric | a | b | diff | p | p_holm | winner | mde |
|---|---|---|---|---|---|---|---|
| f1 | codex-high | claude-high | -0.025 | 0.213 | 0.213 | none | 0.061 |
| f1 | codex-high | agy-high | -0.073 | 0.007 | 0.022 | agy-high | 0.086 |
| f1 | claude-high | agy-high | -0.048 | 0.049 | 0.098 | none | 0.084 |
| wrecall | codex-high | claude-high | 0.024 | 0.213 | 0.213 | none | 0.058 |
| wrecall | codex-high | agy-high | 0.209 | 0.000 | 0.000 | codex-high | 0.097 |
| wrecall | claude-high | agy-high | 0.186 | 0.000 | 0.000 | claude-high | 0.095 |
| precision | codex-high | claude-high | -0.044 | 0.072 | 0.072 | none | 0.074 |
| precision | codex-high | agy-high | -0.295 | 0.000 | 0.000 | agy-high | 0.095 |
| precision | claude-high | agy-high | -0.251 | 0.000 | 0.000 | agy-high | 0.099 |
