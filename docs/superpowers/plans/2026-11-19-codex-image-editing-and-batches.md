# Codex Image Editing and Batches Implementation Plan

> **For agentic workers:** Use Superpowers executing-plans and test-driven-development. Check each step against the approved design and its tests.

**Goal:** Generate or edit one to four images with the signed-in Codex subscription from any DSH tool-capable model.

**Architecture:** Extend the account-bound Images request with an explicit output count or scoped input rasters. Keep scheduling, attachment admission, and durable per-tool presentation in the existing DSH integration.

**Tech Stack:** Node 24, DSH Desktop 0.2.2-rc.3, Cordis Tools, DSH Session Query and attachments, local React renderer.

**Spec:** `docs/superpowers/specs/2026-11-19-codex-image-editing-and-batches-design.md`

## Global constraints

- Default to one output, limit each tool invocation to four, and preserve the existing scalar history format for replay.
- Only resolve current-turn uploads and ordinal results in the latest in-session Codex image batch. Keep pixels out of tool text and validate all source references through DSH.
- Preserve the login generation, fixed endpoints, DSH policy and single-submit safeguards. Add no settings switches.
- The authorized Desktop probe may send one actual `n=2` generation POST. Keep automatic filling disabled only in that one-off probe and restore the production package afterward.

## Review focus

- A count validation response can permit singles, while an unknown outcome never schedules extra calls.
- Cancellation after a completed image leaves that image available after replay, even when DSH drops the successful result metadata.
- Attachment resolution rejects indexes that do not exist and preserves selection order, including older single-image output.
- A model or account change cannot move pending requests onto a different credential or provider.
- The Desktop card distinguishes partial, complete, pending and historical single results.

### Task 1. Account-bound requests, references and batch execution

**Files:** `src/image-generation.mjs`, `src/image-references.mjs`, `src/index.mjs`, `test/image-generation.test.mjs`, `test/image-references.test.mjs`, `test/agent-loop.test.mjs`.

- [x] Write and run failing tests for native count 2, a one-image response followed by singles, explicit rejected count vs unknown failures, and cancellation with saved attachments. Exercise `images/edits` with exact ordered inline data URLs. Keep the existing loopback HTTP 421 regression.
- [x] Test source selection with both recent uploads and past generated images, including the former one-image metadata format and a missing-index rejection.
- [x] Implement the one-request transport, preserving omitted `n` for one output. Decode up to the requested count and bound both individual and aggregate data. Register `codex_edit_image` alongside `codex_generate_image` with the same login admission.
- [x] Resolve references from a Session Query observation and read them through DSH attachments. Commit each confirmed response before any additional paid request. Use persistent metadata for completed and partial results. Use DSH tool content finalization to preserve known partial images on caller cancellation, when the runtime replaces metadata with `ABORTED`.
- [x] Run the Host and cross-model agent tests with the installed DSH Desktop runtime.

### Task 2. Ordered previews and release

**Files:** `src/client.cjs`, `test/client-contract.test.mjs`, `package.json`, `README.md`.

- [x] Write and run failing tests for both keyed tool cards, ordinal downloads, legacy scalar results and cancelled partial results.
- [x] Implement the gallery using the existing DSH loader. Mark incomplete results with actual and requested counts. Document usage and package version `0.5.0`.
- [x] Run the full test suite, syntax and whitespace checks, and package verification. 124 tests passed.

### Task 3. Desktop evidence and deployment

- [x] Mount a one-off package in the existing Desktop that stops after the first `n=2` generation POST. One tool call from `openai/gpt-6.2-sol` requested two images and saved one 1536 × 1024 image. The probe stopped after this successful response.
- [x] Install and enable the final `0.5.0` artifact in the same Desktop. Confirm the installed file hashes and the retained 1 / 2 preview with its download action. Batch completion and editing were exercised against simulated upstream responses through the real DSH Agent Loop.

Review resolved the input event shape, step-scoped reference selection, turn-scoped account binding, partial response retention, and suppression of follow-ups after ambiguous network failures. Results are replayable once the Host writes a tool result. Recovery of images from a process failure before that record exists is outside this version’s normal cancellation path.

## Single-image follow-up for 0.5.1

The user chose a single output for both image generation and reference editing after the probe. The model tool schemas omit the count. Reject a stale request for multiple outputs before sending it and allow at most one Images POST per user turn across both tools. Keep the existing authorized reference selection and replay of historical image cards.

- [x] Cover the absent count parameters, rejection of stale multi-image arguments, one POST across sibling calls, and a single saved result from multiple reference images in the DSH Agent Loop.
- [x] Remove batch scheduling, supplemental requests, and outbound `n`. Keep historical batch readers and the cancellation path for an already-saved image.
- [x] Run all tests and package verification, then verify the installed version and existing result playback in the current Desktop without sending a paid request. All 119 tests passed. The active Desktop displayed both the earlier partial probe record and the single edited PNG.

## Model-visible results for 0.5.2

The generating or editing tool will return its saved DSH attachment as an image in the tool result. DSH can then supply the image to the selected vision model on the continuation step. This uses the same attachment for model input and the conversation card, with DSH handling text-only routes and image request limits. There is one Images request per turn. The conversation model can belong to a different provider from the Codex account that generated the image.

- [x] Update the real DSH Agent Loop test in `test/agent-loop.test.mjs` to require one image in both successful tool results, and the same attachment in the continuation request. Check a text-only continuation and preserve cancellation playback.
- [x] Check that the existing Codex Responses adapter serializes the continuation as a matching `function_call_output` with an `input_image`. Use the real attachment store and simulated upstream responses.
- [x] In `src/image-generation.mjs`, emit the image reference via the shared `output.render` callback. Keep the cancelled result's existing text marker and preserve presentation metadata.
- [x] Update `README.md` and `package.json`, run the full Desktop-runtime tests, and verify the packaged plugin. All 120 tests passed. The active Desktop showed 0.5.2 running and the prior image card with its download action. The visual continuation was exercised with simulated upstream responses.
