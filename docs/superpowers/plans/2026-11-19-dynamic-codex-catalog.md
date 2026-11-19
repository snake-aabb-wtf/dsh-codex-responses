# Dynamic Codex Catalog Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development. Track steps with checkboxes.

**Goal:** Show models returned to the signed-in Codex account in the DSH model picker, without rewriting Responses or hard-coding model names.

**Architecture:** Use a fixed Codex catalog GET in the Host, with a single active account-scoped cache. Project the allowlisted metadata into immutable pi-ai adapter snapshots. The existing OAuth store remains the credential owner; the existing Responses adapter still performs inference.

**Tech Stack:** Node.js 24, DSH 0.2.2-rc.3, pi-ai 1.3.0, `node:test`.

**Spec:** Approved discussion: fetch the authenticated Codex catalog, isolate cache by account, use bundled models only on temporary service/network failure before any successful catalog for that account, and never union the static list into an authoritative response.

## Constraints and Review Focus

- Fixed OpenAI HTTPS origin, no redirects, bounded catalog response and timeout. Do not log bearer tokens, account IDs, or upstream errors.
- Successful empty/filtered catalogs and access denials must not revive static names. During outages keep the last authoritative snapshot for that same identity, including an empty one.
- Sign-out/account changes discard in-flight results; prepared calls must not use a different identity's bearer. A same-account token rotation does not invalidate its catalog.
- Preserve provider-visible modality, visibility and supported effort metadata where available. Do not inject backend instructions or use the OpenAI API route.

## Steps

- [x] Write failing tests for fetching, cache/fallback, stale-account races, and dynamic model resolution and dispatch through the existing Responses wire path.
- [x] Implement the observer in `src/model-catalog.mjs`, account-scoped access in `src/auth.mjs`, and snapshot routing in `src/provider.mjs` and `src/index.mjs`.
- [x] Run the full tests on the installed DSH runtime and inspect `npm pack`. Update the README.
- [ ] Confirm the authenticated online model list in the current Desktop process without sending an inference request.
