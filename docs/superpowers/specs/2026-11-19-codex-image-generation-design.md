# Codex 订阅生图工具首版设计

在 DSH 会话里，用户可以直接请当前模型生成一张图。DeepSeek、ChatGPT Codex 及其他支持 DSH 工具调用的模型都可以发起这项操作。插件使用已登录的 ChatGPT 账号请求 Codex 生图，图片在当前会话的工具卡片里预览和下载。首版只接收文字提示，每次输出一张。参考图编辑与批量出图安排在后续版本。

## 接入方式

- **采用 DSH 工具直连 Codex Images。** 用 `defineTool` 注册 `codex_generate_image`，复用插件现有的设备码登录、凭据存储和 OAuth 刷新。工具执行时由 Host 向固定的 Codex `images/generations` 端点发送独立请求，调用工具的会话模型只负责提供提示词。官方 Codex 原生生图采用这条独立请求路径。[Codex 客户端后端](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/backend.rs) · [Images 请求实现](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs)
- 把托管生图加进 Codex Responses 请求，会让可用性取决于会话所选的推理通道。让 Codex App Server 代理生图会引入额外的进程和部署前提。选用 DSH 工具直连后，可以为各个会话模型共用同一份订阅，并继续由 DSH Agent Loop 调度工具。

## 工具可用性

插件在已登录时向工具目录提供生图能力，与会话选择的 provider 无关。工具的可见性和调用授权沿用当前 DSH 会话的工具策略。「ChatGPT Codex」设置页没有独立的生图开关，也无需配置新的账号或 API key。

DSH 在准备模型回合时判断工具是否可用，并将准入绑定到当时的账号和登录。退出登录或凭据变为需要重新登录时，之后准备的回合会移除该工具。如果由此前已开始的回合发起调用，执行前再次核验凭据与原账号，切换账号或重新登录后需要新回合才能使用生图。目录检查只读本地凭据状态，正常文本对话无需等待图片服务。

## 请求与结果

工具参数只有必填的 `prompt`，经过非空校验。插件只将这条提示词和固定的单张生图参数发给 Codex，图片模型参数按官方生图请求配置。每次工具调用最多发出一次生图 POST，超时或连接中断时提示生成状态无法确认，避免后台重复消耗额度。取消信号贯穿网络请求，HTTP 状态和可识别的上游错误映射成简短的账号、权限、额度或生成失败提示。

Host 解析一张上游返回的图片，限制响应大小，交给 DSH 附件服务校验和保存。工具的文本结果给模型回报成功或失败，工具展示数据记录附件引用。客户端通过这条工具独有的卡片和 DSH 提供的附件加载器显示进度、成功预览或失败信息，成功时提供下载。重新打开会话可凭保存的引用再次查看。模型后续回合接收状态文本，图片字节由 DSH 附件路径交给客户端。当前 DSH 版本的内置图片卡片使用专有子插槽，插件通过自己的工具视图注册入口添加卡片。[DSH 附件接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md) · [DSH 工具视图](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-tool/README.md)

## 验收

- 用模拟上游验证单张请求、取消、鉴权和额度错误、异常结果处理，以及成功后的附件回读。覆盖 DSH Agent Loop 中非 Codex provider 发起调用、工具策略拒绝，以及已登录与退出状态下的可用性。核对现有文本 Responses 路由。
- 复用用户当前的 DSH 桌面客户端。获准消耗真实额度后，在非 Codex 模型的测试会话发起一次文生图，确认当前账号可以调用订阅生图通道，工具卡片能预览与下载，重新打开会话后能加载图片。需要浏览器重新授权时请用户处理。
