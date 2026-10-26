# Real-bug control set

21 real bugs scored (3 left out: some system has no scored run on them); bootstrap over tasks stratified by language, 10,000 resamples, seed 20261017. Kendall tau, synthetic vs real-bug F1: -1.000 (p 0.333, 3 systems).

| system | F1 [95% CI] | wRecall [95% CI] | Precision [95% CI] |
|---|---|---|---|
| agy-high | 0.448 [0.361, 0.539] | 0.318 [0.237, 0.426] | 0.756 [0.658, 0.848] |
| claude-high | 0.528 [0.469, 0.589] | 0.494 [0.409, 0.605] | 0.568 [0.499, 0.637] |
| codex-high | 0.582 [0.495, 0.663] | 0.531 [0.406, 0.671] | 0.643 [0.566, 0.714] |
