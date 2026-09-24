# Supabase 中转代理 — 傻瓜式部署教程

## 这是个啥？

你的 Supabase 域名在大陆被墙了（直连显示 Connection reset，挂梯子才能用）。
这个小项目部署在 Zeabur（海外机房）上，充当"中间人"：

```
你的手机 App ──直连──> Zeabur 代理 ──直连──> Supabase
   (大陆网络)          (海外,不被墙)        (海外,不被墙)
```

App 把原来填 `https://xxxxx.supabase.co` 的地方，改成填 Zeabur 给你的代理地址，就通了。
**API Key、表名、一切其他配置都不用动，只改 URL。**

一个代理同时服务你的三个部分：**MCP、插件、同步聊天记录**。

---

## 准备清单（部署前确认）

- [ ] Zeabur 账号（你说你已经有了 ✓）
- [ ] GitHub 账号（注册一个就行，全程网页操作，不用装任何软件）
- [ ] 你的 Supabase 项目地址（形如 `https://abcdefgh.supabase.co`）
      不知道的话：打开 Supabase 官网 → 你的项目 → 左下角齿轮 Project Settings → API → 第一行 Project URL
- [ ] 你 App 里 MCP 配置的服务器地址（如果 MCP 用的是官方托管版，就是 `https://mcp.supabase.com/mcp`）

---

## 第一步：把代码传到 GitHub

1. 解压 `supabase-proxy.zip`，里面有 3 个文件（`server.js`、`package.json`、`README.md`）
2. 打开 [github.com](https://github.com) 并登录
3. 点右上角 **+** → **New repository**
4. Repository name 填 `supabase-proxy`，其他都不动（Public/Private 都行），点绿色按钮 **Create repository**
5. 创建完的页面上，找到 "**…or push an existing repository...**" 上方有一个 **uploading an existing file** 链接，点它
6. 把解压出来的 3 个文件拖进去，等它上传完
7. 点绿色按钮 **Commit changes**

搞定，代码已经在 GitHub 上了。

---

## 第二步：Zeabur 部署

1. 打开 [zeabur.com](https://zeabur.com) 控制台
2. 顶部 **Create Project**（新建项目），名字随便起，比如 `proxy`
   - 区域（Region）如果让你选：选 **香港** 或 **东京**，离大陆近、延迟低
3. 项目里点 **Add Service** → **Git** → 首次会要求授权 GitHub，授权后选刚才建的 `supabase-proxy` 仓库
4. Zeabur 会自动识别成 Node 项目并开始部署，稍等一两分钟
5. 部署完成后先别急，**还要配环境变量**（见下面）

### 配环境变量（关键步骤！）

在服务的 **Variables（变量）** 标签页，添加两条：

**第 1 条：**

- Name: `TARGETS`
- Value（把 `abcdefgh.supabase.co` 换成你自己的项目地址）:

```
supa=https://abcdefgh.supabase.co,mcp=https://mcp.supabase.com
```

- 含义：起了两个"别名"
  - `supa` = 你的 Supabase 项目（给同步聊天记录、插件用）
  - `mcp` = MCP 服务器（**只有你的 MCP 是官方托管版才这么填**；如果你 App 里 MCP 配的是别的地址，把 `mcp=` 后面换成你 MCP 地址的域名部分，比如 `mcp=https://你的mcp域名.com`）

**第 2 条：**

- Name: `DEFAULT_TARGET`
- Value: `supa`

- 含义：不带别名的请求（如 `/rest/v1/...`）自动转给 Supabase，这样 App 里同步的 URL 只填代理域名就行，最省事

> 提示：等号两边不要有空格，两条别名之间用英文逗号分隔。
> 保存后 Zeabur 会自动重启服务。

### 生成访问域名

1. 进服务的 **Networking（网络）** 标签
2. 点 **Generate Domain**（生成域名），会得到类似 `https://supabase-proxy.xxx.zeabur.app` 的地址
3. 记下这个地址，下面叫它「代理域名」

---

## 第三步：验证（很重要，别跳过）

手机**关掉梯子**，用浏览器打开：

```
https://你的代理域名/_status
```

应该看到一页 JSON，重点看：

```json
"upstream_test": {
  "supa": { "ok": true, "status": 200 },
  "mcp":  { "ok": true, "status": 200 }
}
```

- `ok: true` → 代理能连上目标，一切正常，进入第四步
- 某个 `ok: false` → 环境变量里对应的地址填错了，回第二步检查
- 页面本身打不开 → Zeabur 服务没起来，去服务的 **Logs（日志）** 标签看报错

---

## 第四步：改 App 里的三个配置

**注意：API Key、表名全部不变，只改 URL！**

| 部分 | 在哪里改 | 原来 | 改成 |
|------|---------|------|------|
| 同步聊天记录 | 设置 → 外置记忆库 → 你的记忆库 | `https://abcdefgh.supabase.co` | `https://代理域名` |
| 插件 | 插件配置里填 Supabase 地址的地方 | `https://abcdefgh.supabase.co` | `https://代理域名` |
| MCP | MCP 设置 → 你的服务器 | `https://mcp.supabase.com/mcp` | `https://代理域名/mcp/mcp` |

> MCP 地址的规律：原来的地址是 `https://域名/路径`，新的就是 `https://代理域名/mcp/路径`。
> 例如原 `https://mcp.supabase.com/mcp` → 新 `https://代理域名/mcp/mcp`。

改完关掉梯子，触发一次同步试试，应该不报 Connection reset 了。

---

## 常见问题

**Q: `_status` 里都是 ok，但 App 还是连不上？**
检查 App 里的地址有没有输错（多了斜杠、少了 `/mcp` 前缀之类）。同步和插件填根地址，MCP 要带 `/mcp/mcp`。

**Q: 手机不开梯子打不开代理域名本身？**
极少数地区 `zeabur.app` 也被干扰。解决：Zeabur 的 Networking 里试试换其他域名选项（不同后缀连通性不同）；或者绑定你自己的域名（前提是你有域名且托管在 Cloudflare）。

**Q: MCP 提示要重新登录/授权？**
MCP 的 OAuth 授权页面还在被墙的原域名上。临时开梯子完成一次授权，之后日常调用走代理就正常了（token 已经保存在 App 里）。

**Q: 同步偶尔超时？**
免费版 Zeabur 冷启动有几秒延迟，第一次请求慢是正常的，重试即可。

**Q: 这个代理安全吗？别人拿到我的域名会怎样？**
你的 API Key 都存在 App 本地，代理上不存任何密钥。别人即使知道你的域名，没有你的 Key 也读不了你的数据。如果介意被人蹭流量，可以把环境变量里的别名 `supa` 改成随机字符串（比如 `s8f2k9`），然后 App 里的地址相应变成 `https://代理域名/s8f2k9/...`，别人猜不到就蹭不到。

---

## 改了环境变量怎么生效？

Zeabur 的 Variables 改完会自动重新部署，等状态变成 Running 就生效了，一般 30 秒内。
