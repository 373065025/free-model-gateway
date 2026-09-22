# 免费模型聚合网关

把散落在各家平台的**免费大模型额度**汇总成**一个 OpenAI 兼容入口**，集中给你所有的 AI 客户端（Cherry Studio / NextChat / LobeChat / Cursor / Cline / Dify / 自写脚本…）调用。

零第三方依赖，只用 Node 内置模块 —— 不用 `npm install`，整包约 100 KB，装在 NAS 上也不吃资源。
监控大屏是 Apple 风格的现代界面，**浅色 / 深色 / 跟随系统**三态主题一键切换。
**首次启动必须阅读并同意《用户许可与免责同意书》**才会开放服务；每天还能把用量日报推送到微信。
推送 `v*` 标签即由 GitHub Actions 自动打包发布，网关可从 GitHub Releases 一键热更新。

> [!IMPORTANT]
> **免责声明**：本项目只是运行在你自己设备上的本地「钥匙串 + 转发器」，**不提供任何模型服务**。
> 请遵守你所用各上游平台的条款，因违规使用导致的账号封禁、费用损失等后果由使用者自行承担。
> 完整条款见 [DISCLAIMER.md](DISCLAIMER.md) 与 [docs/用户协议与免责同意书.md](docs/用户协议与免责同意书.md)。

```
                 ┌──────────── 你的 AI 客户端 ────────────┐
                 │  Cherry Studio / NextChat / LobeChat  │
                 └───────────────────┬───────────────────┘
                                     │  一个地址 + 一个 key
                                     ▼
                      ┌──────────────────────────────┐
                      │   免费模型聚合网关 :8790      │
                      │  ─ 路由 / 故障转移            │
                      │  ─ 多密钥轮询 / 限速熔断      │
                      │  ─ 用量统计 / 监控大屏        │
                      └──┬────┬────┬────┬────┬────┬───┘
                         ▼    ▼    ▼    ▼    ▼    ▼
                      Gemini Groq 智谱 硅基流动 Cerebras NVIDIA … 15 个渠道
```

---

## 一、能力清单

| 能力 | 说明 |
| --- | --- |
| OpenAI 兼容接口 | `/v1/chat/completions`（含流式 SSE）、`/v1/models`、`/v1/embeddings` |
| 15 个免费渠道 | Gemini / Groq / OpenRouter / 智谱 / 硅基流动 / 魔搭 / Cerebras / NVIDIA / Cloudflare / Mistral / SambaNova / GitHub Models / Ollama / LM Studio / 内置模拟 |
| 多密钥池 | 同一渠道可挂任意多个 key，自动轮询 + 按当日用量做负载均衡 |
| 故障转移 | 首选渠道 429/5xx 时自动换 key、换渠道、换模型，客户端无感知 |
| 限速熔断 | 按渠道 RPM/RPD 做滑动窗口限速；429 按 `Retry-After` 指数退避；401/403 判定密钥失效并隔离 |
| 智能路由 | `model: auto` 按渠道实时健康度挑一个可用免费模型；`auto:reason` / `auto:code` / `auto:fast` / `auto:long` / `auto:vision` 按能力标签选 |
| 模型别名 | 同一个模型在 5 个渠道有 5 个不同 id，网关统一成 `deepseek-r1`、`llama-3.3-70b` 这样的名字 |
| 免费模型自动发现 | 每小时拉取各平台官方模型列表，按渠道的免费特征过滤后自动纳入调度（免费清单变了你不用管） |
| 用量统计 | 累计调用、输入/输出 tokens、按模型/渠道聚合、29 天趋势、模型排行榜、峰值日 |
| 监控大屏 | Apple 风格的实时 Dashboard：**浅色 / 深色 / 跟随系统**三态主题，含渠道健康、密钥池、模型清单、请求日志、在线自测 |
| 一键打包 | `tools/build_fpk.py` 直接产出飞牛 fnOS 可安装的 `.fpk` |
| 自动更新 | 更新源**默认指向官方仓库**，开箱即用无需配置；检查 / 下载 / 校验 / 热替换 / 自重启，用户密钥与渠道配置永不覆盖，支持回滚 |
| 并发保护 | 每个 key 可设并发上限，打满自动换 key；客户端断开即刻取消上游请求，不浪费额度 |
| 许可与免责同意书 | 首次启动（及同意书升版后）弹出完整条款，**不点同意就不放行任何接口**；同意记录纯本地保存，含 10 章免责/合规/隐私条款 |
| 每日推送日报 | 每天定时把用量汇总（调用次数 / Token / 成功率 / 延迟 / 渠道健康度）推送到微信，基于 [PushPlus](https://www.pushplus.plus/)，默认关闭、token 只存本机 |
| 统一设置页 | 大屏右上角齿轮统一收纳：管理令牌 / 每日推送 / 自动更新 / 备份与恢复四个页签，首页只保留核心监控信息 |
| 配置备份与恢复 | 一键导出渠道、密钥、推送与更新源配置为 JSON 文件，可选 AES-256-GCM 口令加密（PBKDF2 21 万次迭代，口令不落盘）；恢复前先预览摘要再确认，换机迁移配置一步到位 |

---

## 二、本机跑起来（3 步）

```bash
cd "D:\AGG\Documents\WorkBuddy\代理集合服务器"

# 1) 启动（零依赖，不用 npm install）
node src/index.js

# 2) 打开监控大屏
#    http://127.0.0.1:8787/

# 3) 自检：70 项端到端断言，覆盖同意书门禁/鉴权/流式/故障转移/熔断/计量/推送/备份/大屏
node scripts/selfcheck.js
#    （可选）再跑一遍大屏渲染冒烟：node scripts/ui-smoke.js   —— 63 项
#    （可选）更新子系统：node scripts/test-updater.js        —— 50 项
```

启动后终端会打印**访问密钥**（形如 `gw-1d70d66297453f60`），它同时是 Dashboard 的管理令牌。
想直接看大屏效果，可以先灌一份 29 天演示数据（页面会显示「演示数据」角标）：

```bash
node scripts/seed-demo.js      # 想看真实统计：node scripts/reset-data.js
```

---

## 三、配置免费的密钥（关键一步）

网关**默认只有内置模拟渠道可用**，必须先配密钥才会真正去调免费模型。

把 `config/keys.example.json` 复制成 `config/keys.json`，往里填：

```json
{
  "google":      ["AIza...你的 Gemini key"],
  "groq":        ["gsk_...", "gsk_...第二个key"],
  "openrouter":  ["sk-or-v1-..."],
  "zhipu":       ["...你的智谱 key"],
  "siliconflow": ["sk-..."],
  "modelscope":  ["ms-..."]
}
```

也可以完全不改文件，直接用环境变量（多个 key 用英文逗号分隔，优先级高于文件）：

```bash
export GEMINI_API_KEY=AIza...
export GROQ_API_KEY=gsk_aaa,gsk_bbb
```

**先注册哪几个？** 这三家不用绑卡、额度友好，够日常用了：

| 渠道 | 免费额度 | 申请地址 |
| --- | --- | --- |
| Google AI Studio | Flash 档约 1500 次/日、100 万上下文、支持图片 | https://aistudio.google.com/app/apikey |
| Groq | 30 RPM / 1000 RPD，速度最快 | https://console.groq.com/keys |
| 智谱 BigModel | GLM Flash 系列长期免费，国内直连 | https://open.bigmodel.cn/usercenter/apikeys |

配置好之后重启网关，Dashboard 上对应渠道会变绿，`model: auto` 就会开始走真实模型。

> 全部 15 个渠道的申请地址与免费额度说明，在 `config/providers.json` 每个渠道的 `note` 字段里都写了。

---

## 四、接入你的 AI 客户端

只要客户端支持「OpenAI 兼容接口」，填三项即可：

```
API Base URL : http://<网关地址>:8787/v1
API Key      : <终端打印的访问密钥>
模型名称     : auto
```

**Cherry Studio**：设置 → 模型服务 → 添加 → 类型选 `OpenAI` → 填上面三项 → 模型填 `auto`（或具体模型名）
**NextChat**：设置 → 自定义接口 → 接口地址填 Base URL → 模型勾选「自定义」
**LobeChat**：语言模型 → OpenAI → 代理地址填 Base URL
**Cursor / Cline / Continue**：Provider 选 `OpenAI Compatible`，Base URL 同上
**自写脚本**：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="gw-xxxx")

resp = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "你好"}])
print(resp.choices[0].message.content)
print("实际由", resp.x_gateway["provider_name"], "提供")   # 一眼看清这次走了哪个免费渠道
```

响应里的 `x_gateway` 字段会告诉你这次请求的实际渠道、上游模型名、路由方式和耗时，方便排查。

---

## 五、模型名怎么填

| 你填的名字 | 效果 |
| --- | --- |
| `auto` | 自动挑一个当前最健康的免费模型（推荐日常用） |
| `auto:reason` | 要推理能力的（DeepSeek-R1 / GLM / gpt-oss 等） |
| `auto:code` | 要写代码的（Qwen3-Coder / Codestral 等） |
| `auto:fast` | 要低延迟的（Groq 8B / Gemini Flash-Lite 等） |
| `auto:long` | 要长上下文的（100 万 token 级） |
| `auto:vision` | 要能看图的（Gemini / GLM-4V） |
| `deepseek-r1` | 点名要某个模型；网关会自动在 OpenRouter / Groq / NVIDIA / 硅基 / 魔搭 / Cloudflare 之间挑可用的 |
| `gemini-flash` / `glm-flash` / `llama-3.3-70b` / `kimi-k2` … | 同理，都是跨渠道的统称 |
| `mock` | 内置模拟渠道，用来验证链路（不消耗任何额度） |

完整清单：`GET /v1/models`，或直接看 Dashboard 的「可用模型清单」。

---

## 六、装到飞牛 NAS

### 6.1 安装

产物就在项目根目录：**`free-model-gateway1.2.6.fpk`**（约 130 KB）

1. 飞牛 fnOS → 应用中心 → 我的应用 → 右上角「安装应用」（或「手动安装」）
2. 选择这个 `.fpk` 文件，一路下一步
3. 安装完桌面会出现「免费模型聚合网关」图标，点开就是监控大屏

端口固定 **8790**（`manifest.service_port` / `wizard` / `ui/config` / `cmd/main` 四处已对齐，建议别改，改了桌面图标入口会失效）。

### 6.2 首次配置

安装脚本会把配置放到应用的持久目录，并生成一份**人类可读的接入信息**：

```
<应用数据目录>/访问密钥.txt      ← 先看这个，里面有密钥和接入地址
<应用数据目录>/config/keys.json  ← 往这里填各家免费密钥
<应用数据目录>/data/usage.json   ← 调用统计
```

在应用中心 → 该应用 → 「配置文件」/「数据目录」里可以找到。填完密钥后把应用**停止再启动**即可生效。

### 6.3 自己重新打包

```bash
python tools/build_fpk.py        # 自动生成图标 + 打包 + 校验权限位与端口一致性
python tools/verify_fpk.py       # 解包后按 NAS 的方式真跑一次，确认能装能用
```

打包脚本内置了这些校验，避免踩经典坑：

- `cmd/*` 权限必须 755（Windows 打 tar 会丢权限位，装上起不来）
- 内层成员名不能带 `./` 前缀，否则解包后路径错、`server not found`
- `ui/` 必须打在内层，否则桌面图标不出现
- 端口在 manifest / wizard / ui/config / cmd/main 四处必须一致
- 绝不把 `config/keys.json`、`config/update-config.json` 和 `data/` 打进包（防止密钥 / 更新凭据随包外泄）

### 6.4 从 GitHub Releases 一键自动更新

网关自带热更新，**更新源默认就是本项目官方仓库 `373065025/free-model-gateway`，无需任何配置**。
打开监控大屏 →「自动更新」→ 点「检查更新」即可，它会：

请求 GitHub 的 `/releases/latest` → 比对版本 → 下载 Release 里附带的 `free-model-gateway-<版本>.tgz`
→ 校验 sha256 → 备份并热替换 `server/ ui/ manifest` → 自重启。
**用户密钥与渠道配置（`config/`、`server/config/`）永不覆盖。** 面板每 6 小时也会自动检查一次。

发布新版本的完整流程（推标签即全自动）：

```bash
# 1) 改版本号（两处保持一致）
#    fnos/manifest   version = 1.2.6
#    package.json    "version": "1.2.6"

# 2) 打标签并推送 —— 触发 .github/workflows/release.yml
git tag v1.2.6
git push origin v1.2.6
```

CI 会自动：跑端到端自检 + 大屏冒烟 → 打包 `.fpk` → 生成 `free-model-gateway-1.2.6.tgz` 与 `.sha256` → 发布 Release。
之后在网关面板点「检查更新」即可看到新版本并一键升级。

> 本地预生成（不推 GitHub 时）：
>
> ```bash
> python tools/build_fpk.py     # 产出 build/app.tgz（它本身就是热更新单元）
> node tools/make-update.js     # 产出 build/update/{update.json, free-model-gateway-<版本>.tgz}
> ```
>
> 高级用户仍可在 `config/update-config.json` 里用 `githubRepo` 指向自己的 fork / 私有仓库，
> 或用 `githubToken` 提高 API 限额；前端不再暴露这些入口，界面保持极简。

安全要点：下载内容先验 gzip 魔数（`1f 8b`）拦下登录页 HTML；有 sha256 就强校验（GitHub 资产取 API 自带的 `digest`，否则读同名 `.sha256`）；
GitHub 令牌可选（私有仓库 / 提高 API 限额），只存本机配置目录，前端绝不回发明文。

---

## 七、用户许可与免责同意书

本软件会在**首次启动时弹出完整的《用户许可与免责同意书》**，必须勾选并点击「同意」之后才会开放服务。
这是为了把「软件只是本地工具、不提供模型服务、风险自负」这件事讲清楚，降低误用与责任风险。

**门禁规则**

| 请求 | 未同意时 | 已同意后 |
| --- | --- | --- |
| `/v1/*`（所有模型接口） | `403 eula_required` | 正常 |
| `/admin/api/*` 业务接口 | `403 eula_required` | 正常 |
| `/admin/api/eula`、`/admin/api/eula/accept`、`/admin/api/bootstrap` | 放行（否则没法完成确认） | 放行 |
| `/healthz`、Dashboard 静态页面 | 放行（否则探针误报 / 页面打不开） | 放行 |

**行为细节**

- 弹窗**无法跳过**：没有关闭按钮、Esc 与点击遮罩都不生效，必须显式选择「同意」或「不同意」。
- 需要**滚动阅读到条款结尾**才能勾选，避免盲签。
- 同意记录写在数据目录的 `.eula-accepted.json`（含同意的版本号与时间），**纯本地、不上报**。
- 同意书升版后会**自动要求重新确认**（比较版本号，不一致即视为未同意）。
- 随时可以点页脚「用户协议与免责声明」重新阅读（已同意时以只读方式回看）。
- 正文的唯一来源是 [`src/eula.js`](src/eula.js)；仓库文档由 `node tools/gen-eula-doc.js` 导出，两者不会走样。

**相关接口**

| 接口 | 说明 |
| --- | --- |
| `GET /admin/api/eula` | 当前同意状态 + 完整正文（含版本、更新日期、10 个章节） |
| `POST /admin/api/eula/accept` | 记录同意（写入本机同意文件） |

---

## 八、每日推送日报（PushPlus）

每天在设定的时间，自动把网关的整体用量与运行状况汇总成一条消息，推送到**微信**（也可选企业微信 / 邮箱 / 短信 / Webhook）。
默认**关闭**，在 Dashboard 的「每日推送日报」卡片里开启即可。

**为什么用 PushPlus**：它是个免费的消息中转服务（[www.pushplus.plus](https://www.pushplus.plus/)），微信扫码登录后给你一个 token，调用方 POST 一个 JSON 就完事，不需要自建服务器。

### 8.1 配置

1. 打开 [www.pushplus.plus](https://www.pushplus.plus/)，微信扫码登录。
2. 在「一对一推送」页复制你的 **token**（形如 32 位十六进制字符串）。
3. 回到网关 Dashboard，展开「每日推送日报」卡片：
   - 粘贴 token，点「保存设置」
   - 设定推送时间（默认 `09:00`）
   - 可选：填「群组编码」做一对多推送；勾选「当天没有任何调用时不推送」
   - 打开右上角开关启用
4. 点「发送测试」确认能收到消息，再点「预览日报」看看日常内容长什么样。

### 8.2 推送内容

| 包含 | 不包含 |
| --- | --- |
| 今日调用次数与 Token 总量 | ❌ 你的 API 密钥 |
| 累计调用 / 成功 / 失败 / 成功率 / 平均延迟 | ❌ 你的提示词 |
| 输入与输出 Token 分别用量 | ❌ 模型返回的内容 |
| 连续服务天数、渠道健康度、密钥可用数 | ❌ 任何请求正文 |
| 消耗最多的 6 个模型与峰值日 | |

**隐私提示**：开启即表示你同意把上面那份**汇总统计**交由 PushPlus 处理，其处理行为受该第三方隐私政策约束。
token 只保存在本机数据目录的 `notify-config.json`，接口回显一律打码，日志不打印明文，打包发版也会把它排除在外。

### 8.3 行为细节

- **幂等**：同一天最多推一次，按配置时区的自然日判断，重启应用不会重复推送。
- 应用启动后 15 秒会补检查一次（覆盖「到点时应用没开着」的情况），之后每分钟检查一次。
- 「发送测试」**不会**占用当天的推送额度，测试完当天日报照常发。
- 「立即推送一次」与定时推送共用同一套去重记账。
- 想停用：关掉开关，或点 token 旁的「清除」把本机 token 删掉。

---

## 九、运维速查

```bash
node src/index.js              # 启动
node scripts/selfcheck.js      # 57 项端到端自检（同意书门禁 / 鉴权 / 内网令牌判定 / 流式 / 故障转移 / 熔断 / 计量 / 推送 / 大屏）
node scripts/ui-smoke.js       # 61 项 Dashboard 渲染冒烟（真实 DOM 里跑 app.js，含主题切换、陈旧令牌自愈、?token= 直连）
node scripts/test-updater.js   # 33 项自动更新 / 安全逻辑单测（tar 解包、路径穿越、gzip 拦截、GitHub 通道）
node scripts/discover.js       # 手动重新发现免费模型（会写 config/models.discovered.json）
node scripts/seed-demo.js      # 灌 29 天演示数据
node scripts/reset-data.js     # 清空统计（--all 连密钥一起重建）
```

常用管理接口（都需要 `?token=<管理令牌>` 或 `x-admin-token` 头）：

| 接口 | 作用 |
| --- | --- |
| `GET /admin/api/overview` | 大屏全部数据（统计 + 渠道健康 + 日志） |
| `GET /admin/api/models` | 聚合后的模型清单 |
| `POST /admin/api/keys` | 在线添加密钥 `{"providerId":"groq","keys":["gsk_..."]}` |
| `DELETE /admin/api/keys` | 删除密钥 `{"providerId":"groq","key":"gsk_ab...cd"}` |
| `POST /admin/api/discover` | 立即重新发现免费模型 |
| `POST /admin/api/provider-toggle` | 启停某个渠道 `{"providerId":"github","enabled":false}` |
| `POST /admin/api/test` | 在线自测一条请求，返回实际渠道与尝试链路 |
| `POST /admin/api/reload` | 重载配置（改完配置文件不用重启进程） |
| `POST /admin/api/reset-stats` | 统计清零 |
| `GET /admin/api/version` | 当前版本 + 最近一次更新检查结果 |
| `GET /admin/api/update/config` | 查看生效的更新源（默认官方仓库，只读） |
| `PUT /admin/api/update/config` | 高级：改写更新源（`githubRepo` / `githubToken`，供 fork、私有仓库使用） |
| `POST /admin/api/update/check` | 立即检查更新 |
| `POST /admin/api/update/apply` | 下载并热更新（后台任务，返回后轮询状态） |
| `GET /admin/api/update/status` | 更新任务进度 |
| `GET /admin/api/update/backups` / `POST /admin/api/update/rollback` | 列出 / 回滚历史版本 |
| `GET /admin/api/eula` | 用户许可与免责同意书：当前同意状态 + 完整正文 |
| `POST /admin/api/eula/accept` | 记录「已同意」（写本机 `.eula-accepted.json`） |
| `GET /admin/api/notify/config` / `PUT /admin/api/notify/config` | 读取 / 保存每日推送配置（token 回显打码） |
| `GET /admin/api/notify/preview` | 预览当前会推送的日报内容（不发送） |
| `POST /admin/api/notify/test` | 发送一条测试消息 |
| `POST /admin/api/notify/send` | 立即推送一次日报 |

大屏上的「密钥池」「渠道健康状态」「在线自测」「重新发现免费模型」「自动更新」「每日推送日报」就是这些接口的可视化操作。

---

## 十、环境变量（NAS / 容器部署用）

改了环境变量就不用动配置文件：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `GATEWAY_HOST` | 监听地址，NAS 上要 `0.0.0.0` | `127.0.0.1` |
| `GATEWAY_PORT` | 监听端口 | `8787`（fpk 里是 8790） |
| `GATEWAY_CONFIG_DIR` | 配置目录（`providers.json` / `keys.json`） | `<项目>/config` |
| `GATEWAY_DATA_DIR` | 数据目录（`usage.json` / `gateway-key.txt`） | `<项目>/data` |
| `GATEWAY_ADMIN_TOKEN` | 管理令牌，同时可作为客户端 API Key | 自动生成 |
| `GATEWAY_REQUIRE_CLIENT_KEY` | 设 `0` 关闭客户端鉴权（仅内网可信时） | 开启 |
| `GATEWAY_TRUST_LAN` | 设 `0` 关闭「内网自动下发管理令牌」（合租 / 不可信内网时用） | 开启 |
| `GATEWAY_ALLOW_REMOTE_BOOTSTRAP` | 设 `1` 允许公网来源也自动下发管理令牌（**危险**，仅极特殊场景） | 关闭 |
| `GATEWAY_TIMEZONE_OFFSET` | 统计用 UTC 偏移（分钟） | `480`（东八区） |
| `<渠道>_API_KEY` | 各渠道密钥，逗号分隔多个 | 空 |

---

## 十一、目录结构

```
代理集合服务器/
├── src/
│   ├── index.js        HTTP 服务、OpenAI 兼容接口、管理接口、同意书门禁、Dashboard 静态托管
│   ├── upstream.js     路由与故障转移引擎（候选链、重试、流式透传）
│   ├── pool.js         密钥池 / 限速窗口 / 熔断退避 / 渠道评分
│   ├── adapters.js     OpenAI、Anthropic、模拟三种协议适配与归一化
│   ├── config.js       配置加载、模型注册表（别名 → 多渠道路由索引）
│   ├── stats.js        用量统计与落盘
│   ├── discover.js     免费模型自动发现
│   ├── eula.js         《用户许可与免责同意书》正文与同意状态（正文唯一来源）
│   ├── notify.js       每日用量日报 + PushPlus 推送 + 定时调度
│   └── util.js         token 估算、时区、错误分类等
├── public/             Dashboard（原生 HTML/CSS/JS，无构建步骤）
├── scripts/            selfcheck / ui-smoke / test-updater / discover / seed-demo / reset-data
├── tools/              build_fpk.py（打包） / verify_fpk.py（验包） / make_icons.py / gen-eula-doc.js
├── fnos/               fnOS 应用工程（manifest、cmd、config、wizard、ui、图标）
├── docs/               用户协议与免责同意书（由 gen-eula-doc.js 导出）、大屏预览图
├── DISCLAIMER.md       免责声明（仓库版）
├── config/             providers.json（渠道与模型定义）、keys.json（你的密钥，已 gitignore）
└── data/               运行时数据（统计、网关密钥，已 gitignore）
```

---

## 十二、常见问题

**Q：为什么什么都调不通？**
先看 Dashboard 的「渠道健康状态」。没配密钥的渠道是灰色「未配密钥」；只有内置模拟渠道会工作并且回复里明确写着是模拟内容。配好密钥后重启即可。

**Q：某个渠道显示「冷却中」/「失效」怎么办？**
- 「冷却中」是 429 限流，网关会按 `Retry-After` 自动退避，同时把流量切到别的渠道，不用管。
- 「失效」是 401/403，说明这个 key 无效或没开通权限，去大屏「密钥池」里删掉重加。
- 「未配密钥」是根本还没填。

**Q：`auto` 会不会把请求发给不靠谱的模型？**
渠道有 `priority` 权重（Gemini/Groq/OpenRouter 等高分渠道优先），再叠加实时成功率与延迟评分。想固定用某个模型就直接点名，别用 `auto`。

**Q：免费模型的清单经常变，要不要手动维护？**
不用。网关每小时会拉一次各平台官方模型列表，按渠道的免费特征（`:free` 后缀、`flash`/`instant`/`oss` 等关键词）自动过滤并入册。也可以在大屏上点「重新发现免费模型」立即刷新。

**Q：会不会把我的密钥泄露出去？**
不会。密钥只存在本机的 `config/keys.json` 或环境变量里；接口返回和大屏展示都只给掩码（`sk-abc...1234`）；日志里的密钥会被正则脱敏；打包 fpk 时 `keys.json`、`update-config.json`、`notify-config.json`、`.eula-accepted.json` 与 `data/` 都被明确排除。

**Q：打开大屏一直弹同意书，或者接口返回 `403 eula_required`？**
这是首次使用的许可门禁：在点「同意并开始使用」之前，网关不会放行任何模型接口与管理接口（只放行页面本身和 `/healthz`）。
如果你确实想跳过，可以手工在数据目录放一个 `.eula-accepted.json`（内容需含 `"version": "1.0.0"`）——但更建议老实点一下同意。
注意：**同意书升版后会重新要求确认**，这是预期行为。

**Q：重装 / 换过数据目录之后，大屏弹同意书却只显示「管理令牌无效」？**
浏览器 localStorage 里存着**上一次安装的旧管理令牌**——网关密钥是重新生成的，旧的自然失效，于是所有管理接口都 401。
v1.2.3 起已自动处理：在网关所在机器上打开时，前端会主动向服务端换一把新令牌并覆盖本地缓存，**刷新页面即可**，不用手工清缓存。
另外：同意书正文本身**不校验令牌**，所以无论令牌是否有效，条款都一定能读出来、不会被卡在一个看不懂的报错上。

**Q：从电脑浏览器访问 NAS 上的大屏，要填令牌吗？**
**不用。** 网关默认把「内网来源」当作可信（`trustLan`，默认开启）：同一家庭 / 办公室内网里的设备打开大屏，会自动拿到管理令牌并记住，体验和 NAS 桌面图标一样——直接用。
判定规则（`src/net.js`，逐条有单测）：
- 网关所在机器自己（回环 + 本机网卡地址）→ 永远放行；
- 私有网段（`192.168.x` / `10.x` / `172.16-31.x` / 链路本地 / IPv6 ULA）→ 默认放行；
- 公网来源 → 必须显式 `allowRemoteBootstrap: true` 才放行。
想把内网也管起来（例如合租、办公网不太可信），设 `GATEWAY_TRUST_LAN=0` 即可退回「手工填令牌 / 用 `?token=` 地址」的模式：
`http://<NAS 的 IP>:8790/?token=<管理令牌>`（令牌在数据目录 `gateway-key.txt`，前端读到后会**立刻把 `?token=` 从地址栏抹掉**，不留在历史和截图里）。
另：同意书正文**从不校验令牌**，所以条款永远读得到，不会被卡在报错上。

**Q：推送设置保存了，但微信收不到消息？**
按顺序排查：
1. 卡片右上角开关是否为「开启」——**只填 token 不打开开关是不会推的**。
2. 点「发送测试」看是否返回成功。返回成功但没收到，说明 token 有效但 PushPlus 侧渠道没配好（去 pushplus.plus 检查是否已关注公众号）。
3. 看卡片摘要里的「上次推送失败」提示，里面会带 PushPlus 返回的原始原因。
4. 如果勾了「当天没有任何调用时不推送」，而当天确实没流量，那跳过是正常的。
5. 到点时应用必须处于运行状态；如果关了，下次启动后 15 秒会补推一次。

**Q：推送会把我的提示词发出去吗？**
不会。推送的只是一份**汇总统计**（次数、Token 总量、成功率、延迟、渠道健康度、模型消耗排行），不含密钥、提示词与模型返回内容。逐条明细见「八、每日推送日报」的表格。

**Q：想暴露到公网怎么办？**
网关默认绑 `127.0.0.1`。要对外提供，请至少做三件事：改掉 `GATEWAY_ADMIN_TOKEN`、保持 `GATEWAY_REQUIRE_CLIENT_KEY` 开启、在前面套一层 HTTPS 反代并限流。管理令牌同时也是 API Key，别随手发出去。
