# DSH Codex Responses

在 DeepSeek Harness Desktop `0.2.2-rc.3` 中使用 ChatGPT 订阅下的 Codex 模型。插件管理设备码登录、凭据和令牌刷新；DSH 继续管理对话、审批和执行工具。无需 Codex CLI、Codex App Server 或 API key；不支持 SIWC、浏览器回调登录、共享或远程部署。

## 安装与登录（Windows Desktop）

1. 在本目录运行 `npm pack` 生成 `dsh-codex-responses-0.1.5.tgz`。不必先安装依赖或运行构建脚本；源码入口与客户端 bundle 已包含在包中。
2. 通过 Desktop 的 **插件 → 安装插件** 安装本地 `.tgz`，或用 Desktop 自带的 CLI：`dsh plugin --profile desktop add <tgz的绝对路径>`。若安装界面提示需要重新加载，请先保存正在进行的工作。
3. 打开 **设置 → 内置插件 → ChatGPT Codex**，点 **使用设备码登录**。在自己的浏览器打开 [OpenAI 设备验证](https://auth.openai.com/codex/device)，输入插件显示的一次性代码。只确认你自己发起的登录，不把代码或令牌发给任何人。
4. 登录完成后，在会话的模型选择器里选择 **ChatGPT Codex** 下的模型。插件用当前登录向 Codex 拉取模型目录，正常时约每五分钟更新一次；目录中可见不保证每次推理都会被套餐或组织策略接受。插件不改变默认模型，也不转用 API 账单或其他账号。

首次拉取遇到网络或服务临时故障时，用 pi-ai 自带目录临时回退；成功拉取后，暂时断网只保留同一账号的上次目录，不混入静态模型。服务端报告无模型或拒绝访问时，不显示静态目录。退出或切换账号会隔离目录缓存。

在 **设置 → 内置插件 → ChatGPT Codex** 可查看目录来自上游、上次成功缓存还是内置回退。模型选择器只展示现有 Responses 传输能表达的推理档位。

如无法生成设备码，请检查网络，以及 ChatGPT 账号安全设置或组织策略是否允许 Codex 设备登录。提示重新登录时，可在同一面板重登；限流时请等待，不需要重新登录。上游为传统 Codex Responses 接口，不是 OpenAI 公共 API，兼容性可能随上游改变。

## 凭据与卸载

- OAuth grant 由 DSH 凭据服务保存为 `dsh-codex/codex-responses`，默认位于 `$DSH_HOME/.credentials.yaml`。它不是额外加密的凭据保险库；请保持目录的用户权限。不要分享、上传或提交该文件。
- 本插件不会使用官方 Codex、Hermes 或 DSH 内置 pi-ai 的登录。能在当前 DSH Host 运行会话的其他客户端可能消耗该账号额度；不要在共享 Host 启用插件。
- 可先在插件面板 **退出登录**，再从当前 profile 卸载插件。只删除本插件的 grant，不注销其他客户端；卸载 bundle 本身不会删除 DSH 凭据。

## 开发验证

`npm run check` 检查语法，`npm pack --dry-run` 检查发布内容。`npm test` 需要完整的 `0.2.2-rc.3` 依赖。若 npm 注册表缺少对应的 DSH 传递依赖，可直接用本机 Desktop 内置运行时（不启动第二个桌面实例，不读写用户凭据）：

```powershell
$app = "$env:LOCALAPPDATA/Programs/DeepSeek Harness"
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_TEST_RUNTIME = "$app/resources/app.asar/dsh"
& "$app/DeepSeek Harness.exe" --expose-internals --require ./test/desktop-runtime.cjs --test test/*.test.mjs
```

测试使用合成 OAuth grant 与 SSE，不发送真实鉴权或推理请求。
