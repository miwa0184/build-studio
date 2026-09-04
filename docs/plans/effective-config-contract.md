# Plan: effective configuration contract

> **Status: implemented 2026-09-04.** This is a bounded Build Studio
> configuration-correctness slice. It changes no managed-product behavior and
> creates no remote egress.

## Problem

`.build-studio/local.json` looked like a general overlay but the resolver read
only three top-level categories from it. Plausible project-policy settings such
as `builder_strategy: goal` and `support.auto_commit: false` could therefore sit
on disk while the running factory continued with `role` and `true`. The file
expressed intent without changing effective behavior.

The defaults object also declared `final_review` twice. JavaScript kept only the
later declaration, so the advertised default review effort disappeared even
though the wrap-up flag survived.

## Contract

- Tracked `.build-studio/config.yaml` owns project policy.
- Ignored `.build-studio/local.json` is a machine-local preference layer with
  exactly three supported top-level categories: `cli`, `agent_defaults` and
  `step_groups`.
- Loading or writing any other parsed top-level key fails with an explicit
  error. No unsupported key is accepted and silently ignored.
- The three supported categories must alter the effective configuration in a
  resolver-level regression test.
- `final_review` has one default object containing both `effort: high` and
  `wrapup_past_cap: true`.
- Factory-run receipts continue to project the resolved effective
  configuration, never raw file claims.

## Deliberate boundaries

This slice validates the top-level ownership boundary. It does not introduce a
new schema for nested keys inside the three existing categories; those retain
their existing category-specific normalization and API validation.

The established recovery behavior for an absent, unreadable or malformed
optional `local.json` also remains unchanged: the resolver falls back to
tracked YAML. The new refusal applies once a valid JSON object makes an
unsupported top-level claim.

## Falsification and verification

Before the production fix, permanent tests proved three defects:

1. `builder_strategy` and `support` in `local.json` were accepted but inert.
2. `saveLocalOverrides` wrote an unsupported policy category.
3. `DEFAULTS.final_review.effort` was absent.

The same tests now pass, alongside coverage that all three supported local
categories reach the effective resolver output and the receipt test consumes
only supported local overrides.

## Upgrade

Before restarting an existing managed project, inspect its ignored
`.build-studio/local.json`. Move policy keys to tracked `config.yaml` or remove
them if they were inert experiments. Re-inject and restart the project server
after updating Build Studio.
