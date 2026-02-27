# ONTOLOGY_GATEWAY_AUDIT

## 1. Executive Summary
- **闭环状态：WARN**
- 当前已具备基础 `gateway -> ontology` 路由闭环（`ontology.normalize` 已注册并转发到 ontology `/normalize`）。
- **最大阻塞点**：Gateway 对 `ontology.normalize` 的入参校验与 Ontology 实际消费契约不一致。Gateway 接受根级 `tags`，但 Ontology 仅读取 `data.tags`，会出现“Gateway 200/服务 200 但 `normalized=[]`”的静默语义错误。
- 接入主链路前最小必修项（<=3）：
  1. 统一 ontology 契约（Gateway 与 Ontology 对 `tags` 的层级一致化，推荐只允许 `data.tags` 或显式映射）。
  2. 增加 ontology integration smoke（直连 + 经 gateway），覆盖合法/非法/legacy 形态。
  3. 在 `dev_verify` 增加 ontology 检查（当前无 ontology 验证步骤）。

## 2. Ontology Service Contract (Source of Truth)

### 2.1 服务端口
- 默认端口：`5003`
- 证据：`uvicorn.run(..., port=5003)` 在 [services/ontology/main.py:47-48](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/ontology/main.py:47)

### 2.2 Endpoints
- `GET /health`：返回 `{"ok": true, "service": "ontology"}`
  - 证据：[services/ontology/main.py:38-44](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/ontology/main.py:38)
- `POST /normalize`：标签规范化
  - 证据：[services/ontology/main.py:20-35](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/ontology/main.py:20)

### 2.3 Request schema（服务真实消费）
- 顶层模型：`Payload`，仅声明 `data: dict | None`
  - 证据：[services/ontology/main.py:16-17](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/ontology/main.py:16)
- 实际消费字段：`payload.data.tags`
  - `tags` 支持 `string` 或 `list`；其他类型视为无输入（空列表）。
  - 证据：[services/ontology/normalize_rules.py:157-167](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/ontology/normalize_rules.py:157)

### 2.4 Response schema（服务真实输出）
- 返回字段：
  - `dummy: false`
  - `raw: string[]`
  - `normalized: string[]`
  - `unknown: string[]`
  - `taxonomy: object`
  - `mapping_used: object`
- 证据：[services/ontology/normalize_rules.py:216-223](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/ontology/normalize_rules.py:216)

### 2.5 错误码策略
- `POST /normalize` 无显式业务错误分支；缺字段/错类型通常返回 200 且空归一化结果。
  - 证据：`raw_input = data.get("tags")` + fallback 空列表 [services/ontology/normalize_rules.py:158-167](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/ontology/normalize_rules.py:158)
- 若请求体不满足 Pydantic 模型（如非对象），FastAPI 会返回 422（框架默认行为，代码中未覆盖）。
- 未看到显式 400/500 业务错误定义。

### 2.6 Legacy 字段支持
- Ontology 服务本身**未实现 legacy 根级 `tags`**，只认 `data.tags`。
  - 证据：[services/ontology/normalize_rules.py:158-160](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/ontology/normalize_rules.py:158)

## 3. Gateway Route Mapping

### 3.1 Tool 名称与路由
- Tool 名称：`ontology.normalize`
- 路由映射：`/tool/ontology.normalize` -> service `ontology` + path `/normalize`
- 证据：
  - tool route 注册 [gateway/src/main/java/gateway/GatewayServer.java:145](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:145)
  - `/tool/*` 路由入口 [gateway/src/main/java/gateway/GatewayServer.java:57](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:57)
  - tool 名解析逻辑 [gateway/src/main/java/gateway/GatewayServer.java:875-885](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:875)

### 3.2 入参校验
- `ontology.normalize` 校验规则：`hasAnyPath(payload, ["data", "tags", "data.tags"])`
- 失败返回：HTTP 400 + `INVALID_TOOL_INPUT`
- 证据：
  - ontology case [gateway/src/main/java/gateway/GatewayServer.java:362-366](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:362)
  - 统一错误体 [gateway/src/main/java/gateway/GatewayServer.java:420-424](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:420)

### 3.3 白名单与透传
- `ontology.normalize` **没有字段白名单**（不同于 memory/vision/tes_build 的专门校验函数）。
- Gateway 对 ontology 默认**原样透传 incoming body**（未做 schema 重写/裁剪）。
- 证据：
  - 默认 `forwardedBody = incoming` [gateway/src/main/java/gateway/GatewayServer.java:267](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:267)
  - 仅 `memory.read` 和 `embedding.tes_build` 特殊改写 [gateway/src/main/java/gateway/GatewayServer.java:268-275](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:268)

### 3.4 Legacy 映射
- `ontology.normalize` 未做 legacy 映射（例如 `tags -> data.tags`）。
- 证据：仅 `embedding.tes_build` 存在 `data.*` -> root 映射 [gateway/src/main/java/gateway/GatewayServer.java:588-602](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:588)

### 3.5 Timeout
- route timeout：`3000ms`
- 证据：route 定义 [gateway/src/main/java/gateway/GatewayServer.java:145](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:145)

## 4. Port & Config Inventory

| Service | Port | Evidence |
|---|---:|---|
| memory | 5001 | [scripts/dev_up.sh:16-17](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:16), [scripts/dev_up.sh:207](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:207) |
| vision | 5002 | [scripts/dev_up.sh:241](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:241) |
| ontology | 5003 | [services/ontology/main.py:48](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/ontology/main.py:48), [scripts/dev_up.sh:252-253](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:252), [gateway/config.yaml:11](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/config.yaml:11) |
| embedding | 5004 | [scripts/dev_up.sh:214](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:214) |
| recommendation | 5005 | [scripts/dev_up.sh:217](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:217) |
| planner | 5006 | [scripts/dev_up.sh:220](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:220) |
| gateway | 8080 | [gateway/src/main/java/gateway/GatewayServer.java:36](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:36) |
| agent_runtime | 8787 | [scripts/dev_up.sh:17](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:17), [scripts/dev_up.sh:229-230](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:229) |

端口一致性结论：**ontology 端口在代码/脚本/配置/文档均为 5003，一致**。
- 文档证据：[docs/LOCAL_DEV.md:62](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/docs/LOCAL_DEV.md:62)

## 5. 可复制验证命令清单（macOS + bash）

### A) 仅启动 ontology（最小命令）
```bash
cd /Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner
python3 -m uvicorn services.ontology.main:app --host 0.0.0.0 --port 5003
```

### B) 直接 curl ontology /health
```bash
curl -sS http://localhost:5003/health
```

### C) 直接 curl ontology normalize endpoint（样例 payload）
```bash
curl -sS -X POST http://localhost:5003/normalize \
  -H 'Content-Type: application/json' \
  -d '{"data":{"tags":["Ramen","#夜生活","unknown_tag"]}}'
```

### D) 启动 gateway 后，通过 gateway 调 ontology
```bash
cd /Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway
mvn -q exec:java -Dexec.mainClass=gateway.GatewayServer
```
```bash
curl -sS -X POST http://localhost:8080/tool/ontology.normalize \
  -H 'Content-Type: application/json' \
  -d '{"data":{"tags":["Ramen","#夜生活","unknown_tag"]}}'
```

### E) scripts/dev_up.sh with ontology
支持：
```bash
cd /Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner
./scripts/dev_up.sh --with-ontology
```
证据：参数与启动逻辑 [scripts/dev_up.sh:10](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:10), [scripts/dev_up.sh:38](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:38), [scripts/dev_up.sh:247-253](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh:247)

## 6. Findings / Gaps

1. **契约漂移：Gateway 接受根级 `tags`，Ontology 仅消费 `data.tags`**
- 证据：
  - Gateway 校验接受 `tags`：[GatewayServer.java:362-364](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:362)
  - Ontology 只读 `payload.data.tags`：[normalize_rules.py:158-160](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/ontology/normalize_rules.py:158)
  - Gateway 未对 ontology 做映射且默认透传：[GatewayServer.java:267-275](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:267)
- 影响：调用方发送 `{ "tags": [...] }` 可通过 gateway 校验，但 ontology 返回空规范化，造成静默错误。
- 最小修复建议：
  - 方案A：Gateway 对 ontology 仅允许 `data.tags`（拒绝根级 `tags`）。
  - 方案B：Gateway 为 ontology 显式映射 `tags -> data.tags` 并记录兼容路径。

2. **缺少 ontology integration smoke**
- 证据：`tests/integration` 下无 `ontology`/`ontology.normalize` 相关测试（`rg` 无匹配）。
- 影响：契约偏差和回归不会在 CI/本地集成测试暴露。
- 最小修复建议：新增 2 个 smoke（直连 ontology + 经 gateway）。

3. **dev_verify 未覆盖 ontology**
- 证据：
  - `verify_run_e2e.sh` 只校验 memory/reco/embedding/planner，不含 ontology [scripts/verify_run_e2e.sh:63-71](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/verify_run_e2e.sh:63)
  - `dev_verify.sh` 的步骤无 ontology 分支 [scripts/dev_verify.sh:77-97](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_verify.sh:77)
- 影响：`--with-ontology` 启动成功不代表 gateway tool 契约可用。
- 最小修复建议：在 `dev_verify.sh` 增加可选 ontology smoke（服务存在时执行）。

4. **Gateway 解析器使用 YAML 解析请求体（非严格 JSON）**
- 证据：`parsePayloadMap` 使用 `Yaml yaml = new Yaml(); yaml.load(raw)` [GatewayServer.java:433-434](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/gateway/src/main/java/gateway/GatewayServer.java:433)
- 影响：可能接受非严格 JSON 形态，契约边界模糊。
- 最小修复建议：改用 JSON 解析器或在入口强制 JSON 语法校验。

## 接入主链路前 Go/No-Go Checklist（<=5）
1. [ ] `ontology.normalize` 的请求契约已统一（`data.tags` 单一路径，或有明确映射与文档）。
2. [ ] 增加并通过 ontology integration smoke（直连 + gateway）。
3. [ ] `dev_verify` 增加 ontology 校验并在 `--with-ontology` 场景执行。
4. [ ] 明确并固定 gateway 对 ontology 的错误语义（400 输入错误 vs 200 空结果）。
5. [ ] 文档与脚本中的 ontology “standalone/not in /run” 状态与实际实现一致。
