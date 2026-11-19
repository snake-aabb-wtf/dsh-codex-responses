# Codex Subscription Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkboxes to track verification.

**Goal:** A tool-capable DSH model can request one image using the desktop user's ChatGPT Codex subscription and present the result in the session.

**Architecture:** A Host tool owns the image request and uses the plugin's existing OAuth store and DSH attachment service. A keyed DSH tool view loads the persisted attachment through the conversation's existing loader.

**Tech Stack:** Node.js 24, DSH Desktop 0.2.2-rc.3, Cordis, DSH tool and attachment services, React client bundle, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-19-codex-image-generation-design.md`

## Global constraints

- Register `codex_generate_image` with one required `prompt`; generate one image per invocation. Use the existing device-code OAuth login and refresh.
- Admit the tool across model providers; defer tool permissions to DSH. Keep the ChatGPT Codex settings schema and controls as they are.
- Use the standalone Codex Images generation endpoint with the official native tool's single-image defaults. DSH continues to own the Agent Loop.
- Run automated verification without real credentials or requests. Use the user's currently running DSH Desktop for live acceptance, with permission for the real request and user involvement if browser authorization is needed.

## Review focus

- Logout between tool advertisement and execution — fail the call before POST.
- Cancelled or ambiguous network request — no duplicate POST or published result after cancellation.
- Invalid, oversized, or unexpected multi-image upstream response — reject before writing an attachment.
- Text-only or non-Codex conversation model — model receives only text, user still sees and can download the image.
- Historical tool row or unavailable image — render from persisted metadata and give a useful failure state.

### Task 1. Host image transport and DSH tool

**Files:** `src/image-generation.mjs`, `src/index.mjs`, `package.json`, `test/image-generation.test.mjs`, `test/agent-loop.test.mjs`.

- [ ] Write tests for `createCodexImageGenerator({ credentials, oauth, fetch })` returning `generate(prompt, signal)`. Assert the fixed URL, account-bound bearer and account headers, one POST, and bytes plus detected PNG/JPEG/WebP media type. Test blank prompt, sign-out, aborted/failed body, HTTP auth and quota failures, and bounded invalid image responses.
- [ ] Exercise `registerCodexImageTool(ctx, options)` from a non-Codex test adapter in the real DSH Agent Loop. Assert local admission changes with login, a denied call performs no fetch, the accepted call returns a text block, and the recorded result metadata contains a durable `attachment` reference. Run both tests using the installed Electron runtime and confirm the new cases fail before implementation.
- [ ] Implement the Host module. Send `POST https://chatgpt.com/backend-api/codex/images/generations` with `model: 'gpt-image-2'`, `background: 'auto'`, `quality: 'auto'`, and `size: 'auto'`, using the official tool's single-image default. Use a bounded read and a single request deadline; reject invalid base64 and unrecognized types. Wrap execution with DSH `defineTool`, conditionally admit on local login using `when`, and commit through `ctx.attachments.saveImage`. Use a tool-owned canonical attachment schema, text `output.render`, and `output.presentationMeta` returning `{ attachment }`.
- [ ] Wire the tool in the existing Host entry point when the DSH tools and attachments services are ready; declare the tools peer dependency. Run the new Host tests plus the existing text Responses and Agent Loop tests.

### Task 2. Tool card and packaging

**Files:** `src/client.cjs`, `package.json`, `test/client-contract.test.mjs`, `README.md`.

- [ ] Write client contract tests for one registration keyed by `codex_generate_image`, preparing/generating state, sanitized error, attachment-backed result and download link. Assert that the image view does not claim the built-in `tool.call.images` child slot. Run the client suite and confirm the new cases fail before implementation.
- [ ] Register under `tool.call.toolview` and use the provided `loadImage(ref)` lifecycle to show the durable output. Resolve image loading failures within the card; use only trusted metadata and preview URLs from DSH. Add the client tool package dependency in the manifest, document usage, and bump the package version to `0.4.0`.
- [ ] Run the full test suite using the installed Electron runtime. Run `npm run check`, `git diff --check`, and `npm pack --dry-run`. Produce the versioned tarball.

### Task 3. Current Desktop acceptance

- [ ] Install the verified tarball through the current Desktop profile and confirm the loaded Host and client versions. Preserve the user's existing login.
- [ ] With permission for one genuine operation, create a new session using a tool-capable non-Codex model and request one simple image. Verify the recorded call name, image preview, download, and preview after reopening the session. Record the actual upstream/desktop outcome separately from automated verification.
