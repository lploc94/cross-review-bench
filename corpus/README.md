# Cross-Review Bench corpus (private)

Production-grade repositories (`repos/<repo>/`), their pull-request tasks with answer keys (`tasks/<repo>/<task-id>/`), and real open-source bugs (`realbugs/<id>/`). The harness in `cross-review-bench` reads this repository through `CRB_CORPUS`.

This repository contains answer keys. Do not index it with code-search tools, do not show it to a reviewer, and do not publish it except through the harness's release export (public split only).
