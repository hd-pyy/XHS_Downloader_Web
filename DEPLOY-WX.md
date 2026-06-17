# 小程序 HTTPS 代理部署文档

> 本文档说明如何把 **XHS_Downloader_Web** (本仓库) 部署到一台公网服务器上,
> 让微信小程序 `redBookMiniprogram` 通过 HTTPS 调用它作为解析 + 媒体代理后端。
>
> **小程序端不需要任何代码改动**(适配工作全部在服务器侧完成),
> 部署完成后只需在小程序里把 `utils/config.js` 的 4 个 URL 改成你的新域名即可。

---

## 0. 改动总览 (已完成,无需再写代码)

| 文件 | 变更 | 说明 |
|---|---|---|
| `src/routes/wx.ts` | **新增** | `/api/wx/parse` 适配路由,返回小程序期望的 `{ code, data: { type, title, cover, images?, url? } }` 结构 |
| `src/routes/proxy.ts` | **新增** | `/api/proxy-image`、`/api/proxy-video` 代理路由,补 Referer 绕过 XHS CDN 防盗链 |
| `src/server.ts` | 改 | 挂载上述两个路由 + 开启 `trust proxy` |
| `package.json` | 未改 | 不需要新增依赖 (限流用手写的内存桶,够用) |
| `deploy/nginx.conf` | 新增 | Nginx 反代模板 |
| `deploy/xhsdn-web.service` | 新增 | systemd 守护进程模板 |

> 上述代码不破坏任何旧接口 (`/api/parse`、`/api/fetch`、`/api/download/*` 全部保留),Web 端继续正常工作。

---

## 1. 整体架构

```
微信小程序 (redBookMiniprogram, appid:wx88f8e71bc6e6b018)
   │
   │  ① 解析:  wx.request   GET  https://xhs.example.cn/api/wx/parse?url=<xhslink>
   │  ② 下载图: wx.downloadFile GET https://xhs.example.cn/api/proxy-image?url=<XHS CDN url>
   │  ③ 下载视频:wx.downloadFile GET https://xhs.example.cn/api/proxy-video?url=<XHS CDN url>
   ▼ (HTTPS,合法域名)
┌─────────────────────────────────────┐
│ Nginx (443, TLS / Let's Encrypt)    │
│   server_name xhs.example.cn        │
│   reverse_proxy → 127.0.0.1:3030    │
└──────────────┬──────────────────────┘
               ▼
┌─────────────────────────────────────┐
│ XHS_Downloader_Web (Node 18, :3030) │
│   ├─ /api/wx/parse  → 抓 HTML、解析  │
│   ├─ /api/proxy-img → undici stream │
│   └─ /api/proxy-vid → undici stream │
└──────────────┬──────────────────────┘
               ▼  (User-Agent: 小红书 Android, Referer: xiaohongshu.com)
       sns-img-bw.xhscdn.com / sns-video-bw.xhscdn.com
       www.xiaohongshu.com / xhslink.com
```

---

## 2. 接口契约 (小程序端 ↔ 服务器)

### 2.1 `GET /api/wx/parse?url=<xhslink>`

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | number | `0` 成功 / `-1` token 错 / `-2` 入参错 / `-3` 解析失败 / `-4` 限流(被 XHS 风控或本机限流) / `-5` 内部错误 |
| `data.type` | `'图文' \| '视频'` | 小程序按此分支取字段 |
| `data.title` | string | 当前实现是 `小红书 <noteId>` (`NoteDetailsParser` 暂未透出 title) |
| `data.cover` | string (https url) | 封面 |
| `data.images` | string[] | 仅 `type==='图文'` |
| `data.url` | string | 仅 `type==='视频'` |

**示例**:

```bash
curl -sS "https://xhs.example.cn/api/wx/parse?url=https%3A%2F%2Fxhslink.com%2Fa%2FAbCdEf123" | jq
```

```json
{
  "code": 0,
  "data": {
    "type": "图文",
    "title": "小红书 abc123def456",
    "cover": "https://sns-img-bw.xhscdn.com/...",
    "images": [
      "https://sns-img-bw.xhscdn.com/...",
      "https://sns-img-bw.xhscdn.com/..."
    ]
  }
}
```

### 2.2 `GET /api/proxy-image?url=<encoded>` / `GET /api/proxy-video?url=<encoded>`

- 仅放行 host: `*.xhscdn.com`、`*.xiaohongshu.com`、`*.xhslink.com`
- 上行带 `Referer: https://www.xiaohongshu.com/` 绕过 CDN 防盗链
- 响应头透传上游 `Content-Type` / `Content-Length`,**不写** `Content-Disposition`
- 支持 HEAD,小程序 `wx.downloadFile` 偶尔会先 HEAD 探一下

### 2.3 安全

- **IP 限流**: 默认 30 req/min/IP,触发返回 `code: -4`
- **可选 token**: 设置环境变量 `WX_TOKEN=<32位随机>` 启用,小程序请求头加 `x-wx-token: <值>`
- **SSRF 防护**: `/api/wx/parse` 限 xhslink/xiaohongshu 域;proxy 路由限 XHS CDN 子域

---

## 3. 域名 + 备案 + 证书

1. **买域名** (推荐 `xxx.cn` / `xxx.com`,任意一家国内云商)
2. **ICP 备案** (中国大陆服务器必须):主体必须与小程序主体一致;企业 ≈ 10-20 工作日,个人 ≈ 7-15 工作日
3. **解析 A 记录**: `xhs.example.cn` → 服务器公网 IP
4. **证书**: 部署阶段用 `certbot` 自动申请 Let's Encrypt (见第 5 步)

> ⚠️ 必须是 CA 签发的证书,**自签名 100% 被微信 mp 后台拒收**。

---

## 4. 服务器准备 (Ubuntu 22.04 / CentOS 9 通用)

```bash
# Ubuntu / Debian
apt update && apt install -y nodejs npm nginx certbot python3-certbot-nginx git

# CentOS / RHEL / Rocky
dnf install -y nodejs npm nginx certbot python3-certbot-nginx git
```

**Node 版本必须 ≥ 18**(本项目 `package.json` 已声明 `engines.node>=18`)。若发行版自带 Node 太老:

```bash
# 装 Node 20 LTS (任一发行版通用)
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -    # RHEL 系
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -    # Debian 系
```

---

## 5. 部署应用

### 5.1 拉代码 + 构建

```bash
# 1) 创建运行账户
useradd -m -s /bin/bash xhsapp

# 2) 拉仓库
sudo -u xhsapp -H bash -c '
  cd ~
  git clone <你的仓库地址> XHS_Downloader_Web
  cd XHS_Downloader_Web
  npm ci
  npm run build
'

# 3) 试跑确认能起来
sudo -u xhsapp -H bash -c '
  cd ~/XHS_Downloader_Web
  PORT=3030 node dist/server.js
'
# 看到 "xhsdn-web listening on http://localhost:3030" 即可,Ctrl+C
```

### 5.2 配置 systemd 守护

复制本仓库 `deploy/xhsdn-web.service` 到 `/etc/systemd/system/`,按需修改 `WorkingDirectory` 和 `User`:

```bash
cp deploy/xhsdn-web.service /etc/systemd/system/xhsdn-web.service
# 编辑 WX_TOKEN 等环境变量
nano /etc/systemd/system/xhsdn-web.service

systemctl daemon-reload
systemctl enable --now xhsdn-web
systemctl status xhsdn-web         # 看 active (running)
journalctl -u xhsdn-web -f         # 实时看日志
```

### 5.3 配置 Nginx + 证书

```bash
# 1) 复制 Nginx 配置 (按需改 server_name)
cp deploy/nginx.conf /etc/nginx/conf.d/xhsdn.conf
nano /etc/nginx/conf.d/xhsdn.conf   # 把 xhs.example.cn 替换成你自己的域名

# 2) 测试配置 + 启动 Nginx
nginx -t
systemctl enable --now nginx

# 3) 申请证书 (certbot 会自动改 Nginx 配置加 SSL)
certbot --nginx -d xhs.example.cn --agree-tos -m you@example.com --redirect

# 4) 验证自动续期
certbot renew --dry-run
```

### 5.4 验证服务器侧

```bash
# 健康检查 (HTTP→HTTPS 自动跳转)
curl -sI http://xhs.example.cn/api/health         # 期望 301
curl -sI https://xhs.example.cn/api/health        # 期望 200 + JSON
curl -sS https://xhs.example.cn/api/wx/ping       # 期望 {"code":0,"data":{"pong":true,...}}

# 真实解析 (替换成一个有效 xhslink)
curl -sS "https://xhs.example.cn/api/wx/parse?url=https%3A%2F%2Fxhslink.com%2Fa%2Fxxx" | jq

# 代理图片 (替换成上一步返回的 cover URL)
COVER='https://sns-img-bw.xhscdn.com/...'
curl -sI "https://xhs.example.cn/api/proxy-image?url=$(printf %s "$COVER" | jq -sRr @uri)"
# 期望 200, Content-Type: image/jpeg
```

---

## 6. 微信公众平台后台配置

登录 [mp.weixin.qq.com](https://mp.weixin.qq.com) → 用小程序账号 → **开发 → 开发管理 → 开发设置 → 服务器域名**:

| 类型 | 域名 |
|---|---|
| **request 合法域名** | `https://xhs.example.cn` |
| **downloadFile 合法域名** | `https://xhs.example.cn` |

- **不要**带端口、路径、IP、`localhost`
- 必须 ICP 备案、CA 颁发证书、TLS 1.2+
- 一年最多改 **50 次**,改完等 5-10 分钟生效

---

## 7. 小程序端最后一步 (4 行)

只改 `utils/config.js` (不动其它任何文件):

```diff
// utils/config.js
 module.exports = {
   api: {
-    baseUrl: 'https://api.mu-jie.cc',
-    xhs:     '/xhs',
+    baseUrl: 'https://xhs.example.cn',
+    xhs:     '/api/wx/parse',
   },
   proxy: {
-    image: 'https://xgbb.asia/proxy-image?url=',
-    video: 'https://xgbb.asia/proxy-video?url=',
+    image: 'https://xhs.example.cn/api/proxy-image?url=',
+    video: 'https://xhs.example.cn/api/proxy-video?url=',
   },
 };
```

> 若开启了 `WX_TOKEN`,小程序端 `wx.request` 调用还需加 `header: { 'x-wx-token': '<值>' }`。
> 本次实现默认不开 token,只靠 IP 限流;开关在服务器 systemd 文件里。

最后,在微信开发者工具里:
1. 详情 → 本地设置 → **取消勾选**「不校验合法域名」(保证生产 URL 真的能通)
2. 真机扫码预览,粘贴 xhslink 链接,点解析,再点保存。

---

## 8. 五个必踩的坑 (血泪)

1. **证书必须 CA 签发**,自签直接被微信 mp 后台拒。Let's Encrypt 已被微信信任,免费用。
2. **大陆域名必须 ICP 备案**,且主体必须与小程序主体一致;否则后台连"添加服务器域名"按钮都点不动,公网 80/443 也会被运营商封。
3. **XHS CDN 校验 Referer**,本仓库 `src/routes/proxy.ts` 已经写了 `Referer: https://www.xiaohongshu.com/`,**别去删它**,否则上游 403。
4. **`wx.downloadFile` 单文件 ≤ 50MB** (微信限制),超大视频会失败。本次方案不解决,后续可在小程序端加 size 检查或服务端做转码切片。
5. **certbot 必须自动续期**: Ubuntu/CentOS 默认装了 systemd timer (`systemctl status certbot.timer`),否则手动加 cron:
   ```cron
   0 3 * * * certbot renew --quiet --post-hook "systemctl reload nginx"
   ```
   不续期 → 90 天后全站 SSL 报错,小程序请求全挂。

---

## 9. 常用排错

| 现象 | 排查 |
|---|---|
| 小程序报 "域名不在白名单" | 微信 mp 后台没加 / 没生效 (等 5-10 分钟) |
| `curl` 通,小程序不通 | 微信 DevTools 关掉「不校验合法域名」复现一遍;或证书链不全 (`openssl s_client -connect xhs.example.cn:443 -servername xhs.example.cn`) |
| 解析返回 `code: -4` | 大概率被 XHS 风控,等几分钟换 IP;或本机限流触发 (默认 30 req/min) |
| 代理图片返回 403 | 上游 Referer 没带对 (检查 `src/routes/proxy.ts`) 或 URL 已过期 (XHS CDN URL 有时间戳签名) |
| 大视频下载到一半 timeout | Nginx `proxy_read_timeout` 太短 (本仓库模板已设 300s) |
| 限流没生效 (单 IP 不被限) | `trust proxy` 没开 → `req.ip` 总是 127.0.0.1;本仓库 `src/server.ts` 已加 `app.set('trust proxy', true)` |

---

## 10. 文件清单

部署需要的文件全部在仓库里:

```
src/routes/wx.ts                # /api/wx/parse 适配
src/routes/proxy.ts             # /api/proxy-image, /api/proxy-video
src/server.ts                   # 挂载入口 (已修改)
deploy/nginx.conf               # Nginx 模板
deploy/xhsdn-web.service        # systemd 模板
DEPLOY-WX.md                    # 本文档
```

按上述步骤操作,完整链路应当在 **半小时内** (不含备案等待) 跑通。
