# DSH Codex Responses

简体中文 · [English](README.en.md)

在 DeepSeek Harness Desktop `0.2.2-rc.3`、`0.2.2-rc.4` 和 `0.2.2-rc.5` 中使用 ChatGPT 订阅的 Codex 模型。三个版本使用同一个插件包。插件负责设备码登录、OAuth 刷新和模型目录，DSH 负责对话、审批和工具执行。

## 安装与登录（Windows Desktop）

1. 在本目录运行 `npm pack`，生成包含源码和客户端 bundle 的 `dsh-codex-responses-0.5.11.tgz`。
2. 在 Desktop 的 **插件 → 安装插件** 中选择本地 `.tgz`，或用 Desktop 自带的 CLI 运行 `dsh plugin --profile desktop add <tgz的绝对路径>`。
3. 打开 **设置 → ChatGPT**，点 **使用设备码登录**。复制设备码，点 **打开 OpenAI 验证页面**，在浏览器中输入设备码并授权。
4. 在会话的模型选择器中，从 **ChatGPT Subscription** 分组选择模型和推理档位。

登录后，插件约每五分钟同步一次 Codex 模型目录。**设置 → ChatGPT** 显示模型数量和目录来源，包括在线目录、当前账号上次同步的目录和内置目录。

## 用 Codex 订阅生图

登录后，在支持 DSH 工具调用的会话中对 Agent 说「生成一张白底的橙色小猫插画」。每条用户消息可发起一次 Codex 图片请求，输出一张图。

上传一张或多张参考图后，可以让 Agent 调用 `codex_edit_image` 编辑图片，也可以直接说「把刚才生成的小猫图换成蓝底」。在会话卡片中可以预览和下载图片。生图和编辑使用当前账号的 Codex 订阅额度，工具授权由 DSH 管理。

生成或编辑成功后，DSH 会在同一轮把图片交给当前选中的视觉模型，包括其他供应商的模型。纯文本模型收到文字结果。比如可以一次交代「生成一张登录页插图，检查画面后把它用到页面里」。DSH 提供可读的附件路径时，Agent 可以从该路径把图复制到项目。

## 悬浮窗与 API 标价估算

登录后，**设置 → ChatGPT** 的登录管理卡显示邮箱、套餐、已用和剩余额度以及重置时间。在同一页面开启 **悬浮窗**，并从 **显示内容** 里勾选要查看的项目。悬浮窗默认关闭，API 标价估算默认勾选。

- **账号与套餐**显示邮箱和套餐名称。
- **Codex 额度**显示各用量窗口的剩余百分比和重置时间。额度约每分钟刷新一次，悬浮窗展开和折叠时共用同一读数。缓存读数标为「上次」。
- **API 标价估算**按模型的 token 用量和 OpenAI Standard API 标价，计算当前会话和此桌面配置下的累计金额。计入范围为 ChatGPT Codex 订阅请求，分叉继承的用量归入原会话。出现未计价请求或缺失记录时，金额显示为已计价小计。插件自动同步并缓存费率。[OpenAI Standard API 标价](https://developers.openai.com/api/docs/pricing)

点击标题栏折叠或展开，拖动标题栏移动窗口。展开面板和折叠胶囊都可以在松手时平滑吸附到左、右、上、下四边。折叠时左右贴边为竖向胶囊，上下贴边为横向胶囊。贴边后，详情从所贴边缘向窗口内侧展开，拖离边缘可恢复自由摆放。设置页可以重置位置。关闭悬浮窗或升级插件时会保留勾选和位置。

将折叠胶囊拖到左边缘或右边缘附近松手，它会滑到窗边并切换为竖排。点击竖胶囊向窗内展开详情，拖离窗边再松手即可恢复横排。

## 凭据与卸载

DSH 凭据服务以 `dsh-codex/codex-responses` 为键保存插件的 OAuth grant，默认存放在 `$DSH_HOME/.credentials.yaml`。

卸载时，在 **设置 → ChatGPT** 点击 **退出登录** 清除该插件的登录凭据，再从 **插件** 页卸载。

## 开发验证

`npm run check` 检查语法，`npm pack --dry-run` 检查发布内容。安装目标版本的 DSH 测试依赖后，运行 `npm test`。在 Windows 上也可以用 Desktop 内置运行时执行测试。

```powershell
$app = "$env:LOCALAPPDATA/Programs/DeepSeek Harness"
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_TEST_RUNTIME = "$app/resources/app.asar/dsh"
& "$app/DeepSeek Harness.exe" --expose-internals --require ./test/desktop-runtime.cjs --test test/*.test.mjs
```

测试使用合成 OAuth grant 和 SSE 响应。
