# GPT 生图中转站（SillyTavern）

这是普通 SillyTavern/Luker 使用的第三方扩展版，不是 TauriTavern 专用扩展。仓库根目录就是标准 ST 扩展入口，可直接用 Git 安装。

## 安装

在 SillyTavern 的第三方扩展 Git 安装入口填入仓库地址，或下载 ZIP 后解压到 `public/scripts/extensions/third-party/sillytavern-gpt-image-relay`。

本扩展需要 SillyTavern 服务端提供 `/api/openai/generate-image`、`/api/openai/caption-image` 和 `/api/openai/test-image-connection` 代理接口。对应服务端补丁在仓库的 `mobile-patch-v9` 目录；没有补丁时，扩展会尝试直接访问中转站，但手机 WebView 可能受 CORS 限制。

功能包括角色、场景、最后一段生图按钮，自定义端点和 Key，模型/分辨率/风格选择，参考图分析及可编辑结果。分析会优先读取 ST 左侧当前选择的“自定义（兼容 OpenAI）”端点。
