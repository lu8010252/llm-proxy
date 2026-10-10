# LLM 转发网关(个人版)

纯转发,不做任何格式转换,支持流式响应(SSE),自带日志面板,支持多渠道按权重分组 + 失败自动切换(适合把几个免费额度的模型凑成一个"虚拟模型名"用)。

---

## 一、Docker 部署(推荐)

### 方式 A:直接用镜像(不用下载源码)

镜像由 GitHub Actions 自动构建,支持 amd64 / arm64 / armv7:`ghcr.io/lu8010252/llm-proxy:latest`

1. 新建一个文件夹,把本仓库的 `docker-compose.yml` 内容保存进去(或在 1Panel「容器 → 编排」里直接粘贴)。
2. 把 `GATEWAY_KEY`(调用方密钥)和 `ADMIN_KEY`(管理密钥)的 `CHANGE_ME` 改成自己的随机字符串。
3. `docker compose up -d`。首次启动会在 `./data/config.json` 自动生成一份示例配置。
4. 打开 `http://服务器IP:8787/admin/`,输入 ADMIN_KEY,在「配置」页面填入各家 API Key 并保存(热加载,不用重启)。
5. 更新:`docker compose pull && docker compose up -d`。配置在 `./data`,日志在 `./logs`,更新不会丢。

### 方式 B:下载源码本地构建

```bash
# 1. 解压后进入目录
cd llm-proxy

# 2. 准备配置文件
cp config.example.json config.json
# 编辑 config.json,填入你的各家 API Key(见下文说明)

# 3. 启动
docker compose up -d --build
```
(本地构建时,先把 compose 里的 `image:` 一行换成 `build: .`,并把 `./data:/app/data` 与 `CONFIG_PATH` 两行换回 `./config.json:/app/config.json`。)

启动后打开 `http://你的服务器IP:8787` 就是首页仪表盘,能看到渠道状态、今天的请求概况、最近的调用记录,顶部导航可以切到"日志"(完整历史)和"配置"(改 provider / 分组 / 策略)。不用再单独记 `/dashboard/`、`/admin/` 这些路径。

常用命令:

```bash
docker compose logs -f llm-proxy   # 看实时日志
docker compose restart llm-proxy   # 重启
docker compose down                # 停止并删除容器
```

改了 `config.json` 后**不需要重新 build**,直接在"配置"页面保存就会热加载;如果你更喜欢命令行,也可以自己发请求热加载(如果设了 `GATEWAY_KEY`,要带上 `Authorization: Bearer 你的key`):

```bash
curl -X POST http://localhost:8787/api/reload
```

### 多人使用时的密钥设置

- `GATEWAY_KEY`:调用方密钥,**支持逗号分隔多个**,每人发一个,谁的泄露了只删谁的那个。推荐写成 `名字=密钥` 的形式:`GATEWAY_KEY=alice=xxxx,bob=yyyy,carol=zzzz`,这样首页的"调用方统计"和日志里显示的是名字;不写名字的密钥会显示成 `…末4位`。密钥本身不要含 `=`。所有转发路径(`/v1/...` 统一入口、分组、`/provider名/...`)都必须带 `Authorization: Bearer 密钥`。
- `ADMIN_KEY`:管理密钥,**多人使用时强烈建议单独设置**。设置后只有它能进 `/admin/`、看日志、读配置;不设置的话,任何拿到 `GATEWAY_KEY` 的人都能进配置页看到你所有上游 API Key。

**调用方统计**:设置了 `GATEWAY_KEY` 后,首页会多出"调用方统计"卡片,按名字统计每个人今天(或最近 500 条)的请求次数和失败次数;日志页每一行也会标出调用方。统计的是**请求次数**,不含 token 用量;一次请求就算内部自动换了几个渠道重试,也只算一次。日志里只记名字,不记密钥本身。配置了密钥就会显示这张卡片(还没人调用的显示 0 次)。重启或重建容器后,面板会自动从 `logs/` 里的日志文件恢复最近的记录,统计不会清零(以日志保留天数为限)。
- 两个都不设置 = 完全不设防,只适合纯内网自用。

如果你想让网关本身有访问密钥保护(比如部署在公网服务器上),启动前设置环境变量:

```bash
GATEWAY_KEY=your-random-secret docker compose up -d --build
```

设置后调用网关需要带 `Authorization: Bearer your-random-secret`。

### 不用 docker compose,直接 docker run

```bash
docker build -t llm-proxy .
docker run -d --name llm-proxy \
  -p 8787:8787 \
  -v $(pwd)/config.json:/app/config.json:ro \
  -v $(pwd)/logs:/app/logs \
  -e GATEWAY_KEY=your-random-secret \
  llm-proxy
```

---

## 二、不用 Docker,直接跑(备选)

```bash
npm install
cp config.example.json config.json
npm start
```
Node 版本要求 >= 18。

---

## 三、两种调用方式

### 方式一:路径前缀路由(单个 provider,最简单)

```bash
curl http://localhost:8787/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```
把客户端的 base_url 从 `https://api.openai.com` 改成 `http://你的地址:8787/openai` 即可。

### 方式二:统一入口(按 model 名字路由,或走多渠道分组)

所有请求打到同一个地址 `http://localhost:8787/v1/chat/completions`,网关读请求体里的 `model` 字段决定怎么转发,有两种匹配规则:

1. **`modelRouting`**:按前缀匹配单个 provider,比如 `gpt-` 开头就转发去 openai。
2. **`modelGroups`**:见下面重点说明,这是你要的"多个免费 API 凑一个名字,按权重轮着用"的功能。

---

## 四、多渠道分组 + 权重 + 失败自动切换(重点)

这就是你说的 newapi 那种用法:把几个**免费**模型的 API 挂在同一个虚拟模型名下,设置权重,这样客户端只需要认识一个模型名,网关帮你分流,单个渠道的免费额度不容易被打满。

配置示例(`config.json`):

```json
"modelGroups": {
  "free-chat": [
    { "provider": "zhipu", "model": "glm-4-flash", "weight": 3 },
    { "provider": "deepseek", "model": "deepseek-chat", "weight": 2 },
    { "provider": "openrouter", "model": "meta-llama/llama-3.1-8b-instruct:free", "weight": 1 }
  ]
}
```

- `provider`:对应 `providers` 里配置好的那个渠道(含 baseUrl / apiKey)
- `model`:实际转发给上游时用的真实模型名(客户端不需要知道,也不需要关心)
- `weight`:权重,数字越大越容易被抽中,比如上面是 3:2:1 的概率分布

客户端调用时只需要用虚拟名字:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"free-chat","messages":[{"role":"user","content":"hi"}]}'
```

**比单纯按权重轮询更好的一点**:如果抽中的渠道返回了 429(额度超限)或者 5xx(上游故障)这类"可重试"的错误,网关会**自动切换到分组里的下一个渠道重试**,直到成功或者所有渠道都试过一遍,不会让这次请求直接失败给你。可重试的状态码默认是 `[429, 500, 502, 503, 504]`,可以在 `config.json` 顶层用 `retryStatusCodes` 覆盖。

日志面板上能看到每次请求实际落到了哪个渠道、是第几次尝试、总共几个渠道可选,方便确认权重分布是不是符合预期,以及某个渠道是不是老是 429(额度经常超,可以把权重调低)。

### 自动禁用 + 定时恢复

某个渠道命中"额度超限"类的状态码(默认 `403` 和 `429`,可以在 `autoDisableStatusCodes` 里改)时,网关会自动把这个渠道标记禁用,期间选渠道时会**直接跳过**它,不会再浪费一次请求去试。禁用多久有两种模式,在 `autoDisableMode` 里选:

- `"hours"`(默认):固定时长,配合 `autoDisableHours`(默认 24 小时)
- `"resetHour"`:每天固定时间点自动恢复,配合 `autoDisableResetHour`(0-23 的小时数,比如 `1` 就是"次日凌晨 1 点"恢复)。如果触发禁用的时候今天这个时间点还没到,就恢复到今天这个点;已经过了就顺延到明天。这个模式更贴近很多免费 API"每天固定时间重置额度"的规律。

```json
"autoDisableMode": "resetHour",
"autoDisableResetHour": 1
```

⚠️ 用 `resetHour` 模式的话,容器时区要设对,不然"凌晨1点"算的是别的时区。`docker-compose.yml` 里已经默认设了 `TZ=Asia/Shanghai`,不是这个时区就自己改。

也可以在配置管理页 `/admin/` 里手动提前解禁,或者手动禁用某个渠道(比如你知道它这几天在维护)。

### 渠道额度 / 详情(首页「渠道状态」)

首页每个渠道方框会显示额度(剩余金额 / 免费账户状态),点击方框可看详情:渠道状态与恢复时间、额度明细、本渠道请求统计、上游返回的限流响应头。额度结果缓存 1 分钟,详情里可手动刷新。

- OpenRouter:自动查询(`/api/v1/key`),显示 Key 剩余/消费;免费账户会提示每日次数限制
- Agnes、Qwen 等中转站:自动尝试 new-api 的 `/api/usage/token` 和 OpenAI 兼容的 `/v1/dashboard/billing/*`
- 智谱、阶跃:暂未适配,只显示通过网关发生的请求统计
- 查不到或想自己指定接口,在 provider 里加 `quota` 字段:

```json
{
  "name": "xxx",
  "baseUrl": "https://example.com",
  "apiKey": "...",
  "quota": { "type": "custom", "url": "/api/balance", "remainingPath": "data.balance", "totalPath": "data.total", "unit": "$" }
}
```

`type` 可选 `openrouter` / `newapi` / `custom` / `none`(不查);`custom` 的 `*Path` 用点号取 JSON 字段,数值要换算时加 `divisor`。

### 失败通知(ntfy)

在 `config.json` 里配置:

```json
"notify": {
  "url": "https://ntfy.example.com/你的主题"
}
```

两种情况会推送通知:
- 某个渠道触发自动禁用(额度超限)时
- 一次请求把分组里所有渠道都试了一遍还是失败时

不想要通知,把 `notify` 里的 `url` 删掉或留空就行。

---

## 常见大模型 API 地址参考

`config.example.json` 里已经带了这几家(国内节点,都是 OpenAI 兼容接口),直接抄 baseUrl 用就行:

| Provider | baseUrl | 备注 |
|---|---|---|
| OpenAI | `https://api.openai.com` | |
| 阶跃星辰 Step | `https://api.stepfun.com` | |
| Moonshot / Kimi | `https://api.moonshot.cn` | |
| 通义千问(DashScope) | `https://dashscope.aliyuncs.com/compatible-mode` | |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | **需要加 `"pathPrefix": ""`**,见下面说明 |
| DeepSeek | `https://api.deepseek.com` | |
| MiniMax | `https://api.minimaxi.com` | |
| OpenRouter | `https://openrouter.ai/api` | |
| Groq | `https://api.groq.com/openai` | |

再加别的家也一样:只要它提供 OpenAI 兼容的 `/v1/chat/completions` 接口,把 `baseUrl` 填到 providers 里就行,不需要改代码。

### 关于 `pathPrefix`(遇到"拼出来的 URL 多了一段 v1"时用)

网关走统一入口(`/v1/chat/completions`)或分组转发时,默认是拿客户端请求的路径 `/v1/chat/completions` 原样拼到 `baseUrl` 后面。绝大部分厂商(OpenAI、Step、Moonshot、DeepSeek、Qwen、MiniMax、Groq、OpenRouter……)自己的接口也是 `/v1/chat/completions` 这个结构,所以直接拼没问题。

但少数厂商的真实接口不是这个结构,比如智谱的真实地址是 `.../api/paas/v4/chat/completions`,中间没有额外的 `v1`。这种情况给对应 provider 加一个 `pathPrefix` 字段覆盖:

```json
{
  "name": "zhipu",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "apiKey": "xxx",
  "pathPrefix": ""
}
```

`pathPrefix: ""` 的意思是把请求路径里的开头 `/v1` 去掉,只留 `/chat/completions`。如果你自己接入的某家 API 结构也很特殊,对着报错信息里的 `targetUrl`(日志面板点开详情能看到)比对一下真实文档给的地址,照着这个思路调 `pathPrefix` 就行。**只影响统一入口和分组转发**,用路径前缀方式(`/provider名/xxx`)调用时不受这个字段影响,因为那种方式本来就是你自己写全路径。

---

## 配置管理页面 `/admin/`

不用再手动改 `config.json` 了,打开 `http://你的地址:8787/admin/` 就有网页表单可以:

- 增删改 Providers(名字 / baseUrl / apiKey / 认证方式)
- 增删改 Model Groups 里的渠道和权重
- 增删改前缀路由规则
- 改可重试状态码 / 自动禁用状态码 / 自动禁用时长 / ntfy 地址
- 看当前哪些渠道被禁用了,一键手动解禁

点"保存全部配置"会直接写回 `config.json` 并热加载,不用重启容器。

如果你设置了 `GATEWAY_KEY` 环境变量,这个页面顶部有个"管理密钥"输入框,填入跟 `GATEWAY_KEY` 一样的值才能读写配置——**如果准备把网关暴露在公网,强烈建议设置 `GATEWAY_KEY`**,不然任何人都能打开 `/admin/` 改你的 API Key。只在内网/自己电脑用可以不设置。

---

## 五、日志 / 排查报错

- 日志面板:`http://localhost:8787/dashboard/`,2 秒自动刷新,点开一行看完整详情
- 出错(4xx/5xx)时会把上游返回的原始错误内容存进日志(API Key 自动打码)
- 所有日志同时写入 `logs/app.log`(JSON Lines),`tail -f logs/app.log` 随时看
- 内存里只保留最近 500 条给面板用,文件日志持续追加,自己定期清理

---

## 六、目录结构

```
llm-proxy/
├── server.js               # 主程序
├── config.example.json     # 配置示例(复制成 config.json 使用)
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── public/index.html       # 日志面板页面
└── logs/app.log            # 持久化日志(启动后自动生成)
```

## 镜像拉取失败
- 提示 `unauthorized` / `not found`:镜像还是私有的。仓库所有者到 GitHub 个人主页 → Packages → 点开该镜像 →
  Package settings → Change visibility 设为 Public(只需设置一次)。
- 国内服务器拉 `ghcr.io` 很慢或超时:换用能访问 ghcr.io 的机器拉取后 `docker save` / `docker load`,或给 Docker 配置镜像加速/代理。
