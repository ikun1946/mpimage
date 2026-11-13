# GPT 账号池

把 ChatGPT / Codex 账号导入服务端，用账号自己的额度生图，不经过 Magpie。
实现在 `server/src/app/control/accounts/` 与 `server/src/app/products/openai/`。

## 支持的账号与通道

| 通道 | 上游 | 状态 |
|---|---|---|
| **Codex** | `POST https://chatgpt.com/backend-api/codex/responses`（SSE） | 默认启用，只依赖 `Authorization: Bearer <access_token>` |
| Web | `/backend-api/conversation` 等 | 只保存账号，**暂不参与生图**（需要 Sentinel/PoW 与浏览器 TLS 指纹） |

Codex 通道的请求体：`model=gpt-5.5`、`tools[0].type=image_generation`、
`action=generate|edit`、`size=1024x1024`、`quality=auto`、`output_format=png`；
结果从 SSE 的 `image_generation_call.result` 里取 base64。

## 导入格式

后台「GPT 账号池」→ 粘贴或选择文件。支持：

- 每行一个 `access_token`
- `email----access_token` 或 `email access_token`
- 单个 JSON：`{"access_token":"…","refresh_token":"…","email":"…","plan":"plus","type":"codex"}`
- Codex CLI 的 `auth.json`：`{"tokens":{"access_token":"…","refresh_token":"…"}}`（自动按 Codex 处理）
- 数组、`{"accounts":[…]} `、`{"tokens":[…]}`、`{"access_tokens":[…]}`、JSONL

`type` 可以是 `codex` / `web`；不写时按后台选择的「账号类型」处理（默认 Codex）。
同一个 token 重复导入会更新原有记录，不会产生重复账号。

## 客户端模型

导入可用账号后，客户端下拉会出现（没有对应账号的模型不会出现）：

- `g:codex-gpt-image-2` — 任意 Codex 账号
- `g:plus-codex-gpt-image-2` — 仅 Plus
- `g:team-codex-gpt-image-2` — Team / Enterprise
- `g:pro-codex-gpt-image-2` — Pro / Pro Lite

账号全部停用或失效后，这些模型会立即从 `/api/config` 消失。

## 调度与失败处理

- 轮询选择账号；每个账号默认最多 2 个在途请求（后台可改 1–10）
- 401/403 → 账号标记 `invalid`，换下一个账号
- 429 → 按 `Retry-After` 或 60 秒冷却，换下一个账号
- 5xx / 网络错误 → 15 秒冷却后换号
- 内容政策拒绝 → 直接返回错误，不重试
- 最多尝试 3 个账号；都失败时返回「账号池忙」

## 令牌刷新

`access_token` 距过期不足 10 分钟时，用 `refresh_token` 调
`https://auth.openai.com/oauth/token`（`client_id=app_2SKx67EdpoN0G6j64rFvigXD`）。
同一账号的并发请求只发一次刷新；刷新成功会原子写回旋转后的 token。

## 安全

- `gpt-accounts.json` 含 access_token / refresh_token，已在 `.gitignore`；
  写入使用临时文件 + rename，权限 0600
- 后台接口只返回 `sha256:` 指纹与 `hasRefreshToken`，原始 token 不出服务端
- 报错信息写入前会抹掉 Bearer 与长 token 串
- 生产环境请限制后台端口只对本机/内网开放

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GPT_ACCOUNTS_ENABLED` | `1` | 设为 `0` 关闭账号池（账号仍可管理） |
| `GPT_ACCOUNTS_FILE` | `<项目根>/gpt-accounts.json` | 账号库路径 |
| `GPT_ACCOUNTS_BASE_URL` | `https://chatgpt.com` | 上游站点（测试可指向 mock） |
| `GPT_OAUTH_TOKEN_URL` | `https://auth.openai.com/oauth/token` | 刷新令牌地址 |
| `GPT_OAUTH_CLIENT_ID` | `app_2SKx67EdpoN0G6j64rFvigXD` | OAuth 客户端 |
| `GPT_ACCOUNT_CONCURRENCY` | `2` | 每账号默认并发 |
| `GPT_ACCOUNT_MAX_ATTEMPTS` | `3` | 单次生图最多换几个账号 |
| `GPT_ACCOUNT_ACQUIRE_TIMEOUT_MS` | `15000` | 等空闲账号的最长时间 |
| `GPT_CODEX_MODEL` | `gpt-5.5` | Codex responses 模型 |
| `GPT_CODEX_IMAGE_MODEL` | `gpt-image-2` | image_generation 工具模型 |
| `GPT_CODEX_IMAGE_SIZE` | `1024x1024` | 输出尺寸 |
| `GPT_CODEX_IMAGE_QUALITY` | `auto` | 输出质量 |

## 已知限制

- 上游模型 slug、版本号会随 ChatGPT 更新，失效时用环境变量改，不必改代码
- 进程内调度与冷却，多进程部署需要外部租约存储
- Web 账号暂不支持生图
- 账号套餐从 JWT / `/backend-api/me` 读取；读不到时归为「套餐未知」，仍可用基础模型
