# TauriTavern GPT 生图中转站扩展

这是一个纯前端 third-party extension，适用于 TauriTavern 手机版。它不会修改 TauriTavern 的电脑端源码。

功能：

- 左下角三个按钮：角色、场景、最后一段；生成图会挂到当前最新文字段落下，段落原有图片仍可翻阅。
- 通过用户填写的 OpenAI 兼容中转站调用 `/v1/images/generations`。
- “连接测试”会读取 `/v1/models`，返回的模型会出现在生图模型和分析模型下拉框中；两种模型可以独立选择，也可以手填。
- 默认分辨率为 `1920x1080`，支持切换画幅和动漫、二次元、赛璐璐、写实等风格。
- 角色卡 + 当前文字、只读当前界面文字两种来源模式。
- 主角设定和场景角色设定分开控制，避免角色和场景串错。
- 上传参考图后可自动调用中转站视觉模型分析；分析结果显示在右侧文本框并可直接编辑。
- 面板可拖动、最小化，并使用 TauriTavern 的 `free-window` 移动端布局契约。

## 安装

在 TauriTavern 的第三方扩展 Git 安装入口填入本仓库地址：

`https://github.com/shuiyue698/sillytavern-mobile-patch.git`

安装后启用扩展并重新加载页面。打开左下角设置，填写：

1. 中转站的 API 基地址，例如 `https://你的中转站/v1`。不要填写完整的 `/images/generations` 地址。
2. 中转站 Key。
3. 点击“连接测试”，从下拉框选择生图模型和独立的分析模型。

如果中转站不允许 WebView 跨域请求，连接测试会明确显示 CORS/网络错误；需要在中转站放行 TauriTavern 的请求来源。

## API 约定

生图使用 OpenAI 兼容的 `POST /images/generations`；图像分析使用 `POST /chat/completions` 的视觉消息格式。响应支持 `b64_json` 和 `url` 两种图片返回形式。
