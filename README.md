
☁️ 私人实况相册 (Private Live Photo Gallery)

这是一个基于 Cloudflare Workers和 Google Drive的无服务器私人相册应用。无需购买云服务器，利用 Cloudflare 边缘节点提供快速响应，并将高画质媒体文件安全地存储在你的 Google Drive 中。

本项目特别优化了对 iOS 实况图 (Live Photo) 的支持，并内置了大文件分片上传功能，突破了常规网页上传的限制。

 ✨ 特性亮点

* 🚀 纯 Serverless 架构：部署在 Cloudflare Workers，零服务器维护成本。
* 🔐 私密与安全：内置独立的管理员密码验证体系，你的相册仅供你自己访问。
* 📸 原生实况图支持：支持将一张图片与一段 MOV/MP4 视频组合上传，并在前端实现丝滑的 Live Photo 交互体验。
* ⬆️ 大文件分片上传：利用 Google Drive Resumable Upload API，支持大尺寸视频与图片的分片断点续传。
* 🗂️ 高效文件管理：
  * 支持时间轴视图与网格视图自由切换。
  * 支持文件类型过滤（图片、视频、实况图等）。
  * 支持批量选择、批量下载、批量删除与复制直链。
* 📱 响应式设计：完美适配 PC 端与移动端浏览器。

---
🛠️ 部署指南

部署本项目完全免费，只需准备一个 Cloudflare 账号和一个拥有足够容量的 Google 账号即可。

第一步：获取 Google Drive API 凭证

由于应用需要向你的 Google Drive 读写文件，你需要获取以下 4 个关键参数：
1. GOOGLE_FOLDER_ID：
   * 在 Google Drive 中新建一个文件夹用于存放相册媒体。
   * 打开该文件夹，浏览器地址栏中 `folders/` 后面的那串字符就是 Folder ID。
2. GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET：
   * 前往 [Google Cloud Console](https://console.cloud.google.com/)。
   * 创建一个新项目，启用 Google Drive API。
   * 在“凭据”页面，创建一个 OAuth 2.0 客户端 ID（应用类型选择“Web 应用”或“桌面应用”均可）。
   * 获取对应的 Client ID 和 Client Secret。
3. GOOGLE_REFRESH_TOKEN：
   * 使用 [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)。
   * 在设置中勾选 "Use your own OAuth credentials"，填入上一步获取的 ID 和 Secret。
   * 在左侧作用域（Scopes）中输入：`https://www.googleapis.com/auth/drive` 并授权。
   * 点击 "Exchange authorization code for tokens" 获取 *Refresh Token*。

第二步：部署到 Cloudflare Workers

1. 登录 [Cloudflare 仪表盘](https://dash.cloudflare.com/)，进入 *Workers & Pages*。
2. 点击 *创建 Worker* (Create Worker)。
3. 为你的 Worker 起一个名字（例如 `private-gallery`），点击部署。
4. 部署完成后，点击 *编辑代码* (Edit code)
5. 将本项目中的 `worker.js` 代码完整粘贴进去，覆盖原本的默认代码，并点击右上角的 *部署* (Deploy)。

第三步：配置环境变量

代码部署后，为了让程序正常运行，必须配置环境变量。

1. 在你的 Worker 管理页面，选择 *设置 (Settings)* -> *变量和机密 (Variables and Secrets)*。
2. 点击 *添加 (Add)*，依次添加以下 5 个环境变量（请确保变量名完全一致）：

| 变量名 | 说明 |
| --- | --- |
| `ADMIN_PASSWORD` | 自定义你的后台登录密码 |
| `GOOGLE_CLIENT_ID` | 第一步中获取的 Google Client ID |
| `GOOGLE_CLIENT_SECRET` | 第一步中获取的 Google Client Secret |
| `GOOGLE_REFRESH_TOKEN` | 第一步中获取的 Google 刷新令牌 |
| `GOOGLE_FOLDER_ID` | 用于存储文件的 Google Drive 文件夹 ID |

3. 保存配置并重新部署 Worker。

---

 💻 使用说明

1. 访问你的 Cloudflare Worker 域名（例如：`https://your-worker-name.your-subdomain.workers.dev`）。
2. 输入你在环境变量中设置的 `ADMIN_PASSWORD` 登录。
3. 在上方选择你要上传的类型（图片/视频/实况图），选择文件后点击“开始上传”。
   * *注意：上传“实况图”时，需要同时选择一张照片（JPG/HEIC等）和一段关联的动态视频（MOV/MP4）。*
4. 点击卡片上的“预览”或在相册界面直接点击实况图，即可体验播放效果。

---

 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源，你可以自由使用、修改和分发。主包也是比较无聊随便搞着玩的
