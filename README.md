# 企业微信通知服务

本项目提供企业微信通知转发、Web 配置和企业微信回调处理能力。

## 前提条件

- Node.js 18+
- npm
- Docker 与 Docker Compose（使用容器部署时）

## 加密密钥

`ENCRYPTION_KEY` 是必填项，用于加密数据库中的 CorpSecret、EncodingAESKey 和回调 Token。服务没有默认密钥；变量缺失或格式错误时会在监听端口前启动失败。

密钥必须满足以下全部条件：

- 恰好 32 字节；
- 仅包含可打印 ASCII 字符（空格到 `~`）；
- 使用密码学安全随机源生成并具有足够熵；
- 在整个数据生命周期内稳定保存，并在独立的密钥管理或备份系统中留存恢复副本。

可使用项目内置生成器生成符合格式的 32 字符密钥：

```bash
node -e "console.log(require('./src/core/crypto').generateKey())"
```

请将输出直接保存到部署平台的 Secret、密码管理器或受限权限的环境文件，不要提交到 Git、镜像或日志。仓库会忽略 `.env` 和 `.env.*`，但仍应在提交前检查暂存区；不要自行使用人类可记忆短语作为密钥。

### 本地注入

复制模板后填写刚生成的密钥：

```bash
cp env.template .env
```

`env.template` 故意不提供固定密钥；空值不能启动服务。限制 `.env` 文件仅允许服务账号读取，并另行安全备份密钥。

### Docker Compose 注入

`docker-compose.yml` 使用外部必填变量，不包含可直接使用的固定密钥或管理员 Token。先通过当前终端或部署平台 Secret 注入，再启动：

```bash
export ENCRYPTION_KEY='从安全存储读取的32字符密钥'
export ADMIN_TOKEN='从安全存储读取的管理员Token'
docker-compose up -d
```

PowerShell 可使用：

```powershell
$env:ENCRYPTION_KEY = '从安全存储读取的32字符密钥'
$env:ADMIN_TOKEN = '从安全存储读取的管理员Token'
docker-compose up -d
```

如果任一必填变量未注入，Compose 会直接拒绝创建服务。生产部署应优先使用平台 Secret 管理能力，而不是把密钥或 Token 永久写入 shell 配置。

## 管理员认证与权限边界

`ADMIN_TOKEN` 是运行时必填项，必须为至少 32 字符的 base64url 安全随机值（仅 `A-Z`、`a-z`、`0-9`、`_`、`-`）。服务不提供默认值，建议使用独立的密码学安全随机值生成，并与 `ENCRYPTION_KEY` 分开保存：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

以下配置管理端点必须携带 `Authorization: Bearer <ADMIN_TOKEN>`：

- `POST /api/validate`
- `POST /api/generate-callback`
- `POST /api/complete-config`
- `POST /api/configure`
- `GET /api/configuration/:code`
- `PUT /api/configuration/:code`
- `POST /api/configuration/:code/rotate-notify-token`

未提供或提供错误凭证统一返回 `401 {"error":"管理员认证失败"}`。重复创建配置或回调配置返回 `409`，响应不会包含已存在的配置 code 或通知 token。

通知地址使用独立的可轮换通知 token：`POST /api/notify/:token`。该 token 只有发送消息权限，不能读取或修改配置。企业微信回调继续使用稳定的配置 code：`GET/POST /api/callback/:code`。通知和回调端点都不要求 `ADMIN_TOKEN`。

首页要求输入管理员 Token；它只保存在当前页面 JavaScript 内存中，不写入 localStorage、sessionStorage、Cookie 或 URL，刷新页面后必须重新输入。

### 轮换通知 Token

管理员可在首页查找配置后轮换，或直接调用：

```bash
curl -X POST "http://your-server/api/configuration/稳定配置code/rotate-notify-token" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

响应中的 `apiUrl` 是新通知地址。轮换只修改通知 token，不修改 callback/config code；旧通知地址立即失效，企业微信后台已配置的回调 URL 保持不变。

已有 SQLite 数据库在首次启动新版本时会自动新增 `notify_token`，并将其初始化为原 `code`。因此已有通知 URL 和回调 URL 均继续可用；后续主动轮换后，仅旧通知 URL 失效。

### 回调 Token 存储与迁移

回调 Token 属于敏感验证凭证。新写入记录使用从主 `ENCRYPTION_KEY` 独立派生的 AES-256-GCM 密钥、随机 IV 和认证标签加密；等值查找使用另一个独立派生的 HMAC-SHA-256 lookup key。密文和 HMAC 摘要用途分离，不能用数据库中的摘要还原 Token。

`GET /api/configuration/:code` 不返回回调 Token 明文，只在已启用回调时返回 `callback_token_configured: true/false`。管理页面也只显示“已配置/未配置”。调用 `PUT /api/configuration/:code` 时，不提供 `callback_token` 或提供空字符串都会保留原值；只有显式提供非空新值才会替换 Token。

升级已有 SQLite 时，服务会在 `BEGIN IMMEDIATE` 写锁事务中增加 `encrypted_callback_token`、`callback_token_hash` 和 `callback_token_version` 及 lookup 索引。迁移逻辑可读取旧明文记录，也可恢复已存在密文但 hash/version 缺失的中间状态；每条记录经过 GCM 解密校验后，事务内将旧 `callback_token` 明文字段清为 `NULL`。旧列暂不删除，以保持 SQLite 结构兼容。任一密文无法认证、明密文不一致或状态无法恢复时，整个迁移回滚，相关配置业务不会继续使用部分迁移数据。稳定 callback code 和通知 token 均不会改变。

为避免旧明文残留在 SQLite 空闲页或 WAL 中，迁移连接启用 `secure_delete`，提交后执行 WAL truncate checkpoint 和 `VACUUM` 重写；安全清理完成前迁移标记保持 `pending`，失败后下次启动会重试并继续阻止业务使用。迁移前备份仍包含旧明文 Token，必须按高敏感备份限制访问，并在确认迁移和恢复演练成功、超过规定保留期后安全销毁。

该安全模型变更不支持新旧版本混合对外服务：升级时必须先从负载均衡摘除并停止全部旧实例，备份数据库，再仅启动新版本完成迁移。旧版本可能继续写入回调 Token 明文，混合部署会破坏安全边界；确认所有实例均为新版本后才能恢复外部流量。

## 本地运行

```bash
npm install
npm start
```

启动前必须注入有效的 `ENCRYPTION_KEY` 和 `ADMIN_TOKEN`。默认监听 `3000`；可通过 `PORT` 覆盖。默认数据库路径为 `./database/notifier.db`；可通过 `DB_PATH` 覆盖。

## Docker 部署

1. 在外部安全注入 `ENCRYPTION_KEY` 和 `ADMIN_TOKEN`。
2. 构建并启动容器：

   ```bash
   docker-compose up -d
   ```

3. 查看状态和日志：

   ```bash
   docker-compose ps
   docker-compose logs -f
   ```

Compose 默认将服务映射到 `12121` 端口，并把 `./database` 挂载到容器内 `/app/database`。

## 数据与密钥备份

数据库密文和加密密钥必须分别备份；只备份其中一项都无法恢复业务。数据库备份仍包含敏感密文，应限制访问、加密存储并设置保留期限。

普通备份应在停止写入后复制整个数据库文件（以及部署中存在的 WAL 相关文件），或使用 SQLite 在线备份工具创建一致性快照。不要在应用写入时直接复制单个 `.db` 文件。

项目的轮换脚本会在修改数据前通过 SQLite Backup API 自动创建一致性数据库备份。默认写入项目目录的同级受控目录 `../qywx-push-backups/`，文件名为：

```text
<数据库文件名>.backup-<时间戳>
```

也可通过 `BACKUP_PATH` 指定新路径，但脚本会拒绝项目目录内的路径，避免备份进入 Git 提交或 Docker 构建上下文。为防止误覆盖，目标文件已存在时脚本也会拒绝执行。仓库仍以 `.gitignore` 和 `.dockerignore` 排除常见备份命名，作为额外防线。

在 POSIX 系统上，脚本会把备份权限收紧为 `0600`。Windows 上无法通过 POSIX mode 可靠设置 NTFS ACL，因此必须先为备份目录配置仅服务账号可访问的 ACL，并在确认后设置 `WINDOWS_BACKUP_ACL_CONFIRMED=1`；脚本未收到该确认时会在创建备份前拒绝执行。

## 加密密钥轮换

不要直接替换 `ENCRYPTION_KEY` 后启动服务；旧密文将无法解密。请使用以下显式轮换流程。

### 轮换前

1. 安排维护窗口并停止应用，避免备份完成后仍有其他进程写入数据库。
2. 先使用当前旧密钥至少成功启动一次当前版本，确认 callback Token 明文迁移和安全清理已完成；如果数据库已有新加密字段，轮换脚本会严格要求 `callback_token_secure_purge_v1` 标记为 `complete`，并拒绝残留明文、hash/version 不完整或清理仍为 `pending` 的状态。
3. 确认当前旧密钥可用，并从安全存储生成、备份一个新的 32 字符密钥。
4. 确认数据库和备份目录有足够空间。
5. 不要把旧、新密钥写在命令参数中；通过临时环境变量或部署平台 Secret 注入，避免进入 shell 历史和进程参数。

### 执行轮换

轮换脚本读取以下环境变量：

- `OLD_ENCRYPTION_KEY`：当前密钥。仅此迁移脚本兼容旧版本“补 `0` 到 32 字符或截断到前 32 字符”的历史语义；
- `NEW_ENCRYPTION_KEY`：新密钥，必须严格满足恰好 32 字节可打印 ASCII；
- `DB_PATH`：可选，默认 `./database/notifier.db`；
- `BACKUP_PATH`：可选，必须是项目目录之外且尚不存在的备份文件路径；
- `WINDOWS_BACKUP_ACL_CONFIRMED`：Windows 必须设为 `1`，表示备份目录 ACL 已预先限制为仅服务账号可访问。

注入变量后运行：

```bash
npm run rotate-key
```

脚本会依次执行：

1. 校验数据库结构和新密钥；
2. 使用 SQLite Backup API 创建备份；
3. 开启 `BEGIN IMMEDIATE` 事务；
4. 使用旧密钥解密每条 `encrypted_corpsecret` 和 `encrypted_encoding_aes_key`；若数据库已有回调 Token 加密字段，先确认旧明文字段已清空、GCM 版本与 HMAC 摘要完整匹配，再使用旧密钥派生的 GCM key 解密并认证 `encrypted_callback_token`；
5. 校验 CorpSecret 和 EncodingAESKey 解密结果符合企业微信字段的 43 字符格式，以降低错误旧密钥在无认证 AES-CBC 下偶然通过 padding 校验的风险；回调 Token 则由 GCM 认证标签检测错误密钥或密文损坏；
6. 使用新密钥按原有 AES-256-CBC 格式重加密前两个字段，并以新密钥派生的 GCM key 重加密回调 Token，同时用新的 HMAC lookup key 重建 `callback_token_hash` 和版本字段，所有结果都会立即校验；
7. 全部成功后提交；任一记录失败则在提交前回滚整个事务并保留备份。没有回调 Token 新字段的旧版数据库仍可按原有 CBC 流程轮换，随后必须使用新密钥启动当前版本完成 callback Token 迁移。

成功后，清除 `OLD_ENCRYPTION_KEY` 和 `NEW_ENCRYPTION_KEY` 临时变量，把部署环境中的 `ENCRYPTION_KEY` 更新为新密钥，再启动服务并验证配置读取、通知发送和回调。确认业务正常且达到保留期限前，不要删除旧密钥和轮换备份。

### 失败与回滚

- 脚本执行失败时会尝试事务回滚，原数据库应继续使用旧密钥；保持服务停止，检查错误后再决定重试。
- 如果进程中断、自动回滚失败或轮换后业务验证失败，先停止应用，把当前主数据库及同名的 `-journal`、`-wal`、`-shm` 文件作为一个完整文件集复制或移动到隔离目录，不能只保留主 `.db` 后删除 sidecar 文件。
- 确认失败现场副本完整后，清理原数据库路径中的同名文件，把脚本输出的备份复制回 `DB_PATH`，使用旧 `ENCRYPTION_KEY` 启动，并执行 `PRAGMA integrity_check` 后再恢复业务。
- 恢复前不要覆盖唯一备份；失败现场文件集应保留用于排查。
- 只有在使用新密钥完成业务验证、备份验证和恢复演练后，才可按安全策略销毁旧密钥。

## 更新应用

```bash
git pull
docker-compose down
docker-compose up -d --build
```

## 故障排除

```bash
docker-compose logs -f
docker-compose restart
```

服务启动时出现 `ENCRYPTION_KEY必须是恰好32字节的可打印ASCII字符`，表示加密密钥缺失、长度不是 32 字节、包含换行或包含非 ASCII 字符。出现 `ADMIN_TOKEN必须是至少32字符的base64url安全随机值`，表示管理员 Token 缺失或格式错误。错误信息不会回显任何密钥或 Token 内容。

## 安全建议

1. 密钥和数据库分开备份，限制访问并定期演练恢复与轮换。
2. 使用反向代理（如 Nginx）并启用 HTTPS。
3. 限制防火墙，只开放必要端口。
4. 不要在日志、工单、截图或命令行参数中暴露密钥、`ADMIN_TOKEN`、有效配置 code 或通知 token。
5. 将通知 token 仅分发给需要发送消息的系统；配置管理员才应持有 `ADMIN_TOKEN`。
