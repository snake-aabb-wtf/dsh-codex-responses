# Codex Responses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Use a ChatGPT subscription as a native DSH model provider with device-code OAuth.

**Architecture:** A Cordis Host plugin owns a scoped DSH credential and activates a `codex-responses` route via the shipped pi-ai Responses transport and `PiAiAdapter`. A small client settings panel drives the Host authorization flow; the stock DSH Agent Loop remains the only tool executor.

**Tech Stack:** Node.js 24 ESM, `node:test`, DSH `0.2.2-rc.3`, pi-ai `1.3.0`, Cordis/Typert, DSH client slots.

**Spec:** `docs/superpowers/specs/2026-11-19-codex-responses-design.md`; the user's approval supersedes its isolated desktop instruction: verify in the already-running Desktop and ask the user before browser authorization.

## Global Constraints

- No App Server, Codex CLI, SIWC, refresh-token import or API-key fallback.
- Fixed upstream origins; no token, provider error body or device code in durable logs or model data.
- Do not change a default model, touch another credential record, or restart the running application without agreement.
- This checkout has no Git metadata; work in place without creating a worktree or commits.

## Review Focus

- Two expired requests racing against each other; the second observes the persisted rotation.
- Failed or cancelled login with a previous grant; the previous grant survives.
- Unauthorized or disconnected client; it neither starts a login nor receives another caller's code.
- Backend rejects a model or unexpired grant; propagate sanitized error without alternate billing or silently retrying authentication.
- Tools are returned to DSH with stable call IDs, not executed in the provider.

## Task 1: Credential Lifecycle

- [x] Write `test/auth.test.mjs` for injected OAuth `login`/`refresh` and a serialized record store. Cover fixed device selection, sanitized notification, cancellation, existing grant, concurrent refresh, terminal/transient distinction, sign-out and malformed records.
- [x] Run `node --test test/auth.test.mjs`; verify the missing `src/auth.mjs` is the failure.
- [x] Implement `createCredentialStore(credentials, key)` and `runDeviceLogin(session, oauth)` in `src/auth.mjs`; refresh is wrapped safely at the OAuth boundary and rotates within `modifyRecord`. Add targeted tests for any discovered edge cases.
- [x] Rerun `node --test test/auth.test.mjs` and verify all tests pass.

## Task 2: Provider and Desktop Settings

- [x] Add integration tests in `test/provider.test.mjs` and `test/settings.test.mjs` before implementing. Exercise route/model projection and real Responses translation with synthetic SSE, plus the caller-scoped authorization stream and unmount/cancel behavior.
- [x] Run the tests and confirm the missing provider/settings modules cause the expected failures.
- [x] Implement `src/provider.mjs` to construct a fixed Codex profile around `PiAiAdapter`, and mount it in `src/index.mjs` as a plugin with DSH authorization and credentials. Add `src/settings.mjs` and `src/client.cjs` for owner-only live signup status/sign-out, private streamed login progress and settings slot rendering.
- [x] Define packages and bundle patch in `package.json` and `cordis.patch.yml`; build the client factory and compatible Typert endpoint metadata using the rc.3 runtime contract. Run targeted and full tests.

## Task 3: Package, Review and Live Check

- [x] Add `README.md` with supported version, install/remove, device authorization, data location, failure guidance and rollback.
- [x] Check syntax, run the test suite against the installed runtime, and inspect the local pack. Have a fresh reviewer check auth, provider and integration boundaries.
- [x] Install only this bundle through the existing Desktop profile; verify settings and login UI. Do not change other plugin rows or default model. Ask the user to take over in their browser when the login UI is available; do not capture/repeat the code in chat.
- [ ] After the user authorizes, select Codex in a test chat and send one small text request. Keep fixture-only and true subscription checks separate in the handoff.

## Execution Notes

- The public registry could not resolve `@deepseek-ai/dsh-timeout@0.2.2-rc.3`; ran the suite using the exact installed Electron runtime, without using the user's credentials. The Desktop-managed profile installed the package successfully with lifecycle scripts disabled.
- The stock `AgentLoop` integration test uses the actual tool registry and native executor and verifies that the call waits for its pre-execution gate and returns the tool result to the next Codex Responses request.
- Patched the Desktop-client Typert codec and explicit namespace injection after testing the running client. The existing desktop window now renders the Codex panel and reads `signed-out` from the Host.
- The first live attempt requested a device code; the user reported successful browser authorization, but DSH remained signed out. Reproduced two library compatibility defects with synthetic payloads: mandatory `expires_in` and a JWT decoder that does not accept the URL-safe alphabet. The plugin now owns the device and refresh requests and reads JWT expiry if needed. The pi-ai compatibility adjustment is local to inference account parsing; the HTTPS request always carries the original bearer bytes. A second live OAuth and inference result is still needed.
