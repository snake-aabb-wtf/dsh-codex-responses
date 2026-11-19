# DSH Codex Responses 插件设计

目标版本：DeepSeek Harness Desktop `0.2.2-rc.3`（Windows，本机已核查）。

## 目标与范围

在 DeepSeek Harness 中将 ChatGPT 订阅下的 Codex 模型选为当前模型。插件只接管模型路由与设备码 OAuth；对话、工具权限、工具执行、工具结果和后续模型回合继续走 DSH Agent Loop。不启动 Codex App Server、不要求安装 Codex CLI、不接入 SIWC，不引入需填写的 API Key，也不读取或修改 Codex、Hermes 或 DSH 内置 pi-ai 路由的登录凭据。

## 方案取舍

- **采用：独立插件路由，进程内复用 Codex Responses 库。** 用户选定了 Hermes 式直连架构。以 DSH 已有的 pi-ai Codex provider 和 DSH 的 `PiAiAdapter` 作为库复用设备码、刷新、模型声明及协议映射。插件自己发起和取消登录、控制凭据读写和刷新，并绑定自己的模型路由；不用其它程序为它运行 Agent Loop。
- **直接手写 OAuth、协议及 SSE 转换。** 同样不需要子进程，但要重做 token 轮换、流式工具参数、推理回放与错误处理。现有库的公开入口足够，不承担这套重复实现。
- **Codex App Server。** 有公开的 RPC 接口和内置认证，可做独立 Codex 代理；但会增加子进程和第二套任务执行语义，不符合用户选定的 DSH 原生 Agent Loop。

## 插件分层

1. **Host/provider：** 注册独立路由 `codex-responses`，显示为 `ChatGPT Codex`；不替换现有 `openai-codex`。使用 pi-ai `openaiCodexProvider()` 及 DSH `PiAiAdapter`，对模型和 provider 标识做一致的路由绑定。只走 ChatGPT Codex 的固定 HTTPS 端点，不提供自定义推理端点、代理网关或可替换鉴权头。优先使用 SSE。模型目录来自所固定的 Codex 库版本；不宣称目录等于当前账号的授权清单。未登录不展示可用模型；登录/退出后刷新选择器。任何账号计划或组织权限错误都不绕过。
2. **认证：** 注册独立的 `dsh-codex/codex-responses` DSH authorization flow，首版只对外暴露设备码方式。只有人主动点击才开始，桌面端显示官方验证 URL 和短时设备码，不接收用户密码或 token；用户在浏览器授权。Host 将 OAuth grant 作为自己的 scoped record 保存到 DSH 凭据服务，取消或失败不覆盖此前的有效 grant。凭据按 `DSH_HOME` 隔离，使用 DSH 用户目录和文件权限；Windows 不承诺额外的加密或 ACL。状态接口只返回未登录、已登录或需要重登等脱敏状态，不返回资料、token 或短时代码之外的协议字段。
3. **刷新：** 调用前检查过期，复用 pi-ai refresh 与 DSH `modifyRecord` 的跨进程序列化写入；锁内读取最新 grant，保证并发请求不会各自轮换同一 refresh token。短暂网络/限流故障不销毁 grant；能可靠识别为终态的失效凭据需提示重登，不反复重放失效 token。首版不因推理端点提前拒绝仍在有效期内的 token 就盲目刷新、重试或清除凭据；提示检查账号授权或重新登录。退出仅删除本插件的记录，不注销官方 Codex 或撤销整个 ChatGPT 账号。OAuth 输入输出及上游错误体不进入用户会话、模型工具、日志或远程响应；对模型错误保留必要的安全分类。
4. **桌面入口：** 通过 DSH 支持的客户端插件与设置 slot 提供一块最小登录界面：登录、设备码/验证链接、取消、状态、退出。只将这些能力暴露给有对应权限的本地桌面连接；设备码只传给发起者并在尝试结束后清除。不开新服务器，不通过会话 slash 命令传播验证码。登录完成后在原生模型选择器选 Codex，继续使用 DSH 原生聊天界面。模型调用沿用 DSH 的会话权限，不另造权限系统：能在此 Host 运行会话的客户端也可能使用该订阅额度。因此首版把启用范围限定在本人控制的本地 profile，不支持共享/远程部署。

## 交付与验收

- 搭建可安装的 DSH bundle、可复现构建和安装说明。Host 与客户端使用目标版本公开扩展点；不改桌面安装文件、现有 profile、全局设置或现有授权。适配范围只声明实际验证过的版本。
- 本地测试覆盖设备码通知、登录失败/取消、凭据隔离、刷新串行、重登分类、退出、模型目录和脱敏。通过模拟上游响应跑 DSH 模型路由：验证流式文本、批准后由 DSH 执行一个无副作用的测试工具、工具结果进入后续模型调用、取消与错误传播。不会用真实订阅跑自动测试。
- 在隔离的 DSH Desktop 环境验证安装、设置入口、模型选择和卸载：同时隔离 `DSH_HOME` 与 Electron 用户数据，不关闭用户正在用的实例；若无法启动独立桌面实例，先验证目标版本的 CLI/profile 并标明桌面步骤未完成。实际设备码授权由用户在浏览器完成；用户授权后，用一条短对话验证真实 Codex 推理，是否能用订阅额度以服务端结果为准。无法授权则单独标明哪些实机步骤未完成。

## 依据

- [Hermes `auth_codex.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_codex.py) 和 [Codex Responses 转换](https://github.com/NousResearch/hermes-agent/blob/main/agent/codex_responses_adapter.py) 作为架构参考，不直接搬运代码。
- 本机 Desktop 构建包内含 `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.3` 和 `@earendil-works/pi-ai@1.3.0`，后者把当前选择的 `openai-codex` provider 标记为 legacy 并与 SIWC provider 分开。该传输不是 OpenAI 公共 `/v1/responses` API；变更风险由依赖版本固定与实际验收控制。
- [DSH 授权 seam](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/authorization)、[DSH LLM 契约](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm)。
