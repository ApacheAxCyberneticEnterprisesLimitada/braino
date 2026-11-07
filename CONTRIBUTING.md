# Contributing

Work from a short-lived branch and open a pull request against `main`. Keep each
change small enough to review and integrate quickly; squash-merge after the
required checks pass. Long-lived release or integration branches are not used.

Run the focused tests for the code you change during development. The canonical
repository gate is:

```sh
pnpm verify
```

Behavior changes should begin with a failing test that captures the intended
result, then make that test pass and refactor while it remains green.
