# Codex 账号与额度显示

在「设置 → ChatGPT Codex → 显示内容」新增「账号与套餐」「Codex 额度」两项，各自可选、默认关闭。升级保留原有总开关、位置和 API 标价估算偏好。

展开的账号项直接显示完整登录邮箱、套餐和登录状态。折叠时显示套餐或登录状态。已有凭据先读取访问令牌中已有的字段，设备码换取凭据和 OAuth 刷新时从返回的令牌提取补充字段。缺失值单独标明。账号资料由本地 Host 处理，经本地所有者专用的接口只返回显示字段。

额度项展开显示 Codex 主额度窗口的剩余比例、重置时间和读取时间，折叠显示比例摘要。窗口名称按上游时长确定，百分比为一百减去已用比例。额度查询使用与现有设备码登录相同的账号，读取 ChatGPT 后端的 `/wham/usage`。额度项可见时立即读取，之后每分钟刷新；短暂失败时显示同一账号最近一次结果及更新时间。无可用窗口时显示「额度暂不可用」。退出或重新登录清除旧快照，关闭总开关或取消勾选时结束对应读取。

额度和 API 标价各自显示。额度只读，现有 OAuth、Responses 传输和 DSH Agent Loop 继续按原路径工作。

展开标题显示「ChatGPT Subscription」。已登录时，「设置 → ChatGPT Codex」上方的登录管理卡展示完整邮箱、套餐及每个 Codex 窗口的已用比例、剩余比例和重置时间。查看设置独立于悬浮窗的开关，两个界面同时打开时共享额度查询。

## 接入方式

沿用插件已有的设备码凭据，在本地 Host 复用令牌刷新与账号范围检查。App Server 的账号协议和 Codex 客户端的 HTTP 使用路径提供字段依据。选择在插件内增加只读查询，这与现有直连部署方式相符。[Codex 客户端查询实现](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs#L618-L641) · [账号字段实现](https://github.com/openai/codex/blob/main/codex-rs/login/src/token_data.rs#L950-L990)
