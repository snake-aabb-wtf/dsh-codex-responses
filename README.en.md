# DSH Codex Responses

[简体中文](README.md) · English

Use Codex models from your ChatGPT subscription in DeepSeek Harness Desktop `0.2.2-rc.3`, `0.2.2-rc.4`, and `0.2.2-rc.5`. The same plugin package supports all three versions. The plugin handles device-code sign-in, OAuth token refresh, and model discovery. DSH manages conversations, approvals, and tool execution.

## Installation and sign-in on Windows

1. Run `npm pack` from this directory to create `dsh-codex-responses-0.5.7.tgz`, which contains the plugin source and client bundle.
2. In DSH Desktop, open **Plugins → Add plugin** and select the local `.tgz` file. You can also use the Desktop CLI and run `dsh plugin --profile desktop add <absolute-path-to-tgz>`.
3. Open **Settings → ChatGPT Codex** and select **Sign in with a device code** (使用设备码登录). Copy the code, select **Open the OpenAI verification page** (打开 OpenAI 验证页面), then enter the code and authorize sign-in in your browser.
4. In the conversation's model picker, select a model and reasoning level from the **ChatGPT Codex** group.

After sign-in, the plugin refreshes the Codex model catalog about every five minutes. **Settings → ChatGPT Codex** shows the model count and identifies the active catalog. It can use the live catalog, the latest catalog saved for the current account, or the built-in catalog.

## Generate images with your Codex subscription

In a conversation with DSH tool calling enabled, ask the agent to “Create an illustration of an orange kitten on a white background.” Each user message can trigger one Codex image request, which produces one image.

Upload one or more reference images and ask the agent to edit them with `codex_edit_image`. You can also ask it to “Give the kitten image you just made a blue background.” Preview or download the result from the tool card. Generation and editing use the signed-in account's Codex allowance, and DSH manages tool permissions.

DSH passes each generated or edited image to the selected vision model in the same turn, including vision models from other providers. Text-only models receive a text result. For example, ask the agent to “Create an illustration for the sign-in page, review it, and use it on the page.” When DSH supplies a readable attachment path, the agent can copy the image into the project.

## Overlay and API price estimates

Once signed in, the account card in **Settings → ChatGPT Codex** shows your email, plan, usage, remaining allowance, and reset times. On the same page, enable **Overlay** (悬浮窗) and select what to show under **Display content** (显示内容). The overlay starts off, with the API price estimate selected by default.

- **Account and plan** (账号与套餐) shows your email and plan name.
- **Codex usage** (Codex 额度) shows the remaining percentage and reset time for each usage window. The expanded and collapsed overlay share a reading that refreshes about once per minute. Cached readings are labeled **Last recorded** (上次).
- **API price estimate** (API 标价估算) applies OpenAI's published standard API rates to token usage by model. It shows an estimate for the current conversation and a cumulative estimate for this Desktop profile. The estimate covers ChatGPT Codex subscription requests. Usage inherited by a fork is counted in the original conversation. When records or prices are missing, the display shows the subtotal for priced requests. The plugin refreshes and caches the rates automatically. [OpenAI standard API pricing](https://developers.openai.com/api/docs/pricing)

Click the title bar to collapse or expand the overlay, or drag it to move the overlay. Both the expanded panel and the collapsed pill glide to the left or right edge when released nearby. Click the title bar while docked to switch between the vertical pill and the details panel, or drag away from the edge to place it freely. You can reset its position in Settings. Your selections and position are saved when you close the overlay or upgrade the plugin.

Release the collapsed pill near the left or right edge to slide it into a vertical dock. Click the docked pill to expand it toward the center of the window. Drag it away from the edge and release it to return to the horizontal layout.

## Credentials and uninstallation

The DSH credential service stores the plugin's OAuth grant under the key `dsh-codex/codex-responses`. The default storage path is `$DSH_HOME/.credentials.yaml`.

To uninstall, select **Sign out** (退出登录) in **Settings → ChatGPT Codex** to clear the plugin credentials, then uninstall the plugin from the **Plugins** page.

## Development checks

Run `npm run check` to check syntax and `npm pack --dry-run` to inspect the package contents. Install the test dependencies for the target DSH version, then run `npm test`. On Windows, you can also run the tests with the runtime bundled with DSH Desktop.

```powershell
$app = "$env:LOCALAPPDATA/Programs/DeepSeek Harness"
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_TEST_RUNTIME = "$app/resources/app.asar/dsh"
& "$app/DeepSeek Harness.exe" --expose-internals --require ./test/desktop-runtime.cjs --test test/*.test.mjs
```

The tests use synthetic OAuth grants and SSE responses.
