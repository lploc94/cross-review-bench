# Leaderboard (synthetic corpus)

144 tasks; bootstrap over tasks stratified by repo, 10,000 resamples, seed 20261017. Precision is 1 for a system with no findings. pass^k / pass@k: share of pool bugs found in all / any of the k runs, over the tasks a system has all k runs of (the leaderboard JSON gives the bugs counted and those left out).

| rank | system | F1 [95% CI] | wRecall [95% CI] | Precision [95% CI] | false_alarm_rate | location_accuracy | pass_all_k | pass_any_k | BT [95% CI] | median_wall_s | median_output_tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | agy-high | 0.780 [0.734, 0.822] | 0.707 [0.646, 0.766] | 0.871 [0.822, 0.917] | 0.052 | 0.962 | 0.598 | 0.686 | +0.01 [-0.18, 0.21] | 325.000 | 14019.000 |
| 2 | claude-high | 0.732 [0.695, 0.766] | 0.892 [0.861, 0.922] | 0.620 [0.572, 0.666] | 0.207 | 0.918 | 0.734 | 0.917 | +0.02 [-0.16, 0.20] | 141.000 | 7354.500 |
| 3 | codex-high | 0.707 [0.663, 0.748] | 0.916 [0.884, 0.944] | 0.576 [0.523, 0.629] | 0.478 | 0.922 | 0.817 | 0.909 | -0.03 [-0.22, 0.15] | 179.000 | 3682.000 |
