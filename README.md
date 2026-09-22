# 免费模型聚合网关

把散落在各家平台的**免费大模型额度**汇总成**一个 OpenAI 兼容入口**，集中给你所有的 AI 客户端（Cherry Studio / NextChat / LobeChat / Cursor / Cline / Dify / 自写脚本…）调用。

零第三方依赖，只用 Node 内置模块 —— 不用 `npm install`，整包约 93 KB，装在 NAS 上也不吃资源。
推送 `v*` 标签即由 GitHub Actions 自动打包发布，网关可从 GitHub Releases 一键热更新。

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
| 监控大屏 | 暗色 + 金色的实时 Dashboard，含渠道健康、密钥池、模型清单、请求日志、在线自测 |
| 一键打包 | `tools/build_fpk.py` 直接产出飞牛 fnOS 可安装的 `.fpk` |
| 自动更新 | 面板填 GitHub 仓库即可检查 / 下载 / 校验 / 热替换 / 自重启；用户密钥与渠道配置永不覆盖，支持回滚 |
| 并发保护 | 每个 key 可设并发上限，打满自动换 key；客户端断开即刻取消上游请求，不浪费额度 |

---

## 二、本机跑起来（3 步）

```bash
cd "D:\AGG\Documents\WorkBuddy\代理集合服务器"

# 1) 启动（零依赖，不用 npm install）
node src/index.js

# 2) 打开监控大屏
#    http://127.0.0.1:8787/

# 3) 自检：31 项端到端断言，覆盖鉴权/流式/故障转移/熔断/计量/大屏
node scripts/selfcheck.js
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

产物就在项目根目录：**`free-model-gateway1.2.0.fpk`**（约 93 KB）

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

网关自带热更新：监控大屏 →「自动更新」→「更新源设置（GitHub）」里填仓库 `owner/repo`，之后它会：

请求 GitHub 的 `/releases/latest` → 比对版本 → 下载 Release 里附带的 `free-model-gateway-<版本>.tgz`
→ 校验 sha256 → 备份并热替换 `server/ ui/ manifest` → 自重启。
**用户密钥与渠道配置（`config/`、`server/config/`）永不覆盖。**

发布新版本的完整流程（推标签即全自动）：

```bash
# 1) 改版本号（两处保持一致）
#    fnos/manifest   version = 1.2.1
#    package.json    "version": "1.2.1"

# 2) 打标签并推送 —— 触发 .github/workflows/release.yml
git tag v1.2.1
git push origin v1.2.1
```

CI 会自动：跑 31 项自检 → 打包 `.fpk` → 生成 `free-model-gateway-1.2.1.tgz` 与 `.sha256` → 发布 Release。
之后在网关面板点「检查更新」即可看到新版本并一键升级。

> 本地预生成（不推 GitHub 时）：
>
> ```bash
> python tools/build_fpk.py     # 产出 build/app.tgz（它本身就是热更新单元）
> node tools/make-update.js     # 产出 build/update/{update.json, free-model-gateway-<版本>.tgz}
> ```
>
> 想用自建 / 镜像更新源，在面板「高级：自定义 / 镜像更新源」里填 `update.json` 地址即可（GitHub 拉不动时的备用通道）。

安全要点：下载内容先验 gzip 魔数（`1f 8b`）拦下登录页 HTML；有 sha256 就强校验（GitHub 资产取 API 自带的 `digest`，否则读同名 `.sha256`）；
GitHub 令牌可选（私有仓库 / 提高 API 限额），只存本机配置目录，前端只回显「是否已配置」，绝不回发明文。

---

## 七、运维速查

```bash
node src/index.js           # 启动
node scripts/selfcheck.js   # 31 项端到端自检
node scripts/test-updater.js # 33 项自动更新 / 安全逻辑单测（tar 解包、路径穿越、gzip 拦截、GitHub 通道）
node scripts/discover.js    # 手动重新发现免费模型（会写 config/models.discovered.json）
node scripts/seed-demo.js   # 灌 29 天演示数据
node scripts/reset-data.js  # 清空统计（--all 连密钥一起重建）
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
| `PUT /admin/api/update/config` | 设置更新源（GitHub 仓库 / 自定义源） |
| `POST /admin/api/update/check` | 立即检查更新 |
| `POST /admin/api/update/apply` | 下载并热更新（后台任务，返回后轮询状态） |
| `GET /admin/api/update/status` | 更新任务进度 |
| `GET /admin/api/update/backups` / `POST /admin/api/update/rollback` | 列出 / 回滚历史版本 |

大屏上的「密钥池」「渠道健康状态」「在线自测」「重新发现免费模型」「自动更新」就是这些接口的可视化操作。

---

## 八、环境变量（NAS / 容器部署用）

改了环境变量就不用动配置文件：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `GATEWAY_HOST` | 监听地址，NAS 上要 `0.0.0.0` | `127.0.0.1` |
| `GATEWAY_PORT` | 监听端口 | `8787`（fpk 里是 8790） |
| `GATEWAY_CONFIG_DIR` | 配置目录（`providers.json` / `keys.json`） | `<项目>/config` |
| `GATEWAY_DATA_DIR` | 数据目录（`usage.json` / `gateway-key.txt`） | `<项目>/data` |
| `GATEWAY_ADMIN_TOKEN` | 管理令牌，同时可作为客户端 API Key | 自动生成 |
| `GATEWAY_REQUIRE_CLIENT_KEY` | 设 `0` 关闭客户端鉴权（仅内网可信时） | 开启 |
| `GATEWAY_TIMEZONE_OFFSET` | 统计用 UTC 偏移（分钟） | `480`（东八区） |
| `<渠道>_API_KEY` | 各渠道密钥，逗号分隔多个 | 空 |

---

## 九、目录结构

```
代理集合服务器/
├── src/
│   ├── index.js        HTTP 服务、OpenAI 兼容接口、管理接口、Dashboard 静态托管
│   ├── upstream.js     路由与故障转移引擎（候选链、重试、流式透传）
│   ├── pool.js         密钥池 / 限速窗口 / 熔断退避 / 渠道评分
│   ├── adapters.js     OpenAI、Anthropic、模拟三种协议适配与归一化
│   ├── config.js       配置加载、模型注册表（别名 → 多渠道路由索引）
│   ├── stats.js        用量统计与落盘
│   ├── discover.js     免费模型自动发现
│   └── util.js         token 估算、时区、错误分类等
├── public/             Dashboard（原生 HTML/CSS/JS，无构建步骤）
├── scripts/            selfcheck / discover / seed-demo / reset-data
├── tools/              build_fpk.py（打包） / verify_fpk.py（验包） / make_icons.py
├── fnos/               fnOS 应用工程（manifest、cmd、config、wizard、ui、图标）
├── config/             providers.json（渠道与模型定义）、keys.json（你的密钥，已 gitignore）
└── data/               运行时数据（统计、网关密钥，已 gitignore）
```

---

## 十、常见问题

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
不会。密钥只存在本机的 `config/keys.json` 或环境变量里；接口返回和大屏展示都只给掩码（`sk-abc...1234`）；日志里的密钥会被正则脱敏；打包 fpk 时 `keys.json` 与 `data/` 被明确排除。

**Q：想暴露到公网怎么办？**
网关默认绑 `127.0.0.1`。要对外提供，请至少做三件事：改掉 `GATEWAY_ADMIN_TOKEN`、保持 `GATEWAY_REQUIRE_CLIENT_KEY` 开启、在前面套一层 HTTPS 反代并限流。管理令牌同时也是 API Key，别随手发出去。
