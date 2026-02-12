# DecisionTrace Coverage Gap Report

## TL;DR
- 当前 `decision_trace` 覆盖核心在 recommendation (`recall/rerank/mix_policy`) 与 planner `ez_fill`，但多数只到聚合层，缺少逐项证据。  
- `mix_policy` 可追溯性最好（`rule_id/confidence/reasons/components` 已完整）。  
- `cross_city_guard` 已有计数证据，但缺少被拒绝 item IDs。  
- planner fallback 已有触发标记，但缺少候选池规模与每步填充来源明细。  
- intent/gateway/ontology/memory 多数判断尚未统一进入顶层 `decision_trace`（多为 NO 或 PARTIAL）。  
- 建议按 skill 粒度补齐 trace：`guard/filter/score/fallback/routing` 五类优先。  

## Decision Points Inventory (Trace Gaps)

| decision_id | file:line_range | category | trace_status | recommended_skill_name | notes |
|---|---|---|---|---|---|
| REC_CZ_CITY_MATCH | `services/recommendation/recall.py:82-107` | recall_filter | PARTIAL | `skill.recall_cz_city_match` | Current: `decision_trace.recall.rules_used` + `candidate_counts` (`services/recommendation/main.py:300-312`)；Gap: 无 `accepted_ids/rejected_ids` 与命中规则证据。 |
| REC_EZ_CITY_EXCELLENCE | `services/recommendation/recall.py:114-127` | recall_filter | PARTIAL | `skill.recall_ez_city_excellence` | Current: `decision_trace.recall.thresholds.recall_ez_excellence_threshold`；Gap: 无阈值比较明细（边界命中、被过滤数量按原因）。 |
| REC_MAX_CAND_CAP | `services/recommendation/recall.py:129-142` | truncation_limit | NO | `skill.recall_cap_candidates` | Current: 仅日志 warning；Gap: 未记录 cap 前后数量、被截断 ids。 |
| REC_CITY_LEAK_CHECK | `services/recommendation/recall.py:150-160` | guard | NO | `skill.recall_city_leak_guard` | Current: 仅日志 error；Gap: 无 trace 字段输出 leak 详情。 |
| RERANK_CZ_CROSS_CITY_GUARD | `services/recommendation/rerank.py:682-703` | guard | PARTIAL | `skill.cross_city_guard` | Current: `decision_trace.rerank.filters.cz_cross_city_rejected` (`services/recommendation/rerank.py:786-789`)；Gap: 缺少 `rejected_ids/rejected_cities`。 |
| RERANK_EZ_DISTANCE_FILTER | `services/recommendation/rerank.py:446-449,716-725` | threshold_filter | PARTIAL | `skill.ez_taste_distance_filter` | Current: `decision_trace.rerank.filters.ez_filter_reasons`；Gap: 无逐 item 过滤证据（id + distance + threshold）。 |
| RERANK_EZ_SIM_CAP | `services/recommendation/rerank.py:440-445` | score_component_cap | PARTIAL | `skill.ez_similarity_cap` | Current: top item components 含 `taste_similarity_raw/capped`；Gap: 无“多少候选触发 cap”的聚合统计。 |
| RERANK_CZ_SCORE_FORMULA | `services/recommendation/rerank.py:255-294,307-381` | scoring | PARTIAL | `skill.rerank_cz_score_components` | Current: `decision_trace.rerank.top_items[*].components` + `weights`；Gap: 仅 top5，无全候选分量与排序前后 rank 变化。 |
| RERANK_EZ_DIVERSITY_MMR | `services/recommendation/rerank.py:543-595` | diversity | PARTIAL | `skill.mmr_diversity` | Current: `decision_trace.rerank.diversity` 含 `lambda/selected_ids`；Gap: 缺少每轮 mmr 对比分数与被抑制项。 |
| RERANK_TOPK_TRUNCATE | `services/recommendation/rerank.py:727-744` | ranking | PARTIAL | `skill.rerank_topk` | Current: `decision_trace.rerank.thresholds.top_k_*`；Gap: 无截断前数量与被截断 ids。 |
| MIX_POLICY_MAIN_DECISION | `services/recommendation/mix_policy.py:36-136,210-280` | policy_selection | YES | `skill.mix_policy_core` | Current: `decision_trace.mix_policy` 已含 `rule_id/confidence/reasons/components` (`services/recommendation/main.py:347-351`)。 |
| MIX_POLICY_EMPTY_BRANCH | `services/recommendation/mix_policy.py:61-109` | fallback_policy | YES | `skill.mix_policy_empty_fallback` | Current: `no_candidates/only_ez_available/only_cz_available` rule 已可追踪。 |
| PLAN_CITY_FILTER_SORT | `services/planner/card_builder.py:145-149` | filter_sort | PARTIAL | `skill.planner_city_filter_sort` | Current: `planner_trace.selected_*`；Gap: 无被 city filter 排除项、排序 key 证据。 |
| PLAN_EZ_FILL_EXCELLENCE | `services/planner/card_builder.py:157-176` | fallback | PARTIAL | `skill.ez_fill_fallback` | Current: `planner_trace.ez_fill_triggered/source/reason`；Gap: 无 `fill_item_ids` 与 `pool_size_before_fill`。 |
| PLAN_EZ_FILL_FROM_CZ | `services/planner/card_builder.py:177-190` | fallback | PARTIAL | `skill.ez_fill_from_cz` | Current: source 可标记为 `cz_pool`；Gap: 无“为何 excellence fallback 后仍不足”的量化证据。 |
| PLAN_TRACE_MERGE | `services/planner/main.py:196-210` | trace_merge | PARTIAL | `skill.trace_merge_planner_reco` | Current: reco trace + planner trace merge；Gap: 无 `merge_sources/merge_order/conflict_policy` 元数据。 |
| INTENT_CITY_DETECT | `agent_runtime/src/agents/intentAgent.ts:45-52,95-101` | intent_parse | PARTIAL | `skill.intent_city_detect` | Current: `meta.decision_trace.intent_agent.city` (`agent_runtime/src/agents/intentAgent.ts:142-153`)；Gap: 无命中的 regex/rule 名细节。 |
| INTENT_TYPE_AND_SEED | `agent_runtime/src/agents/intentAgent.ts:58-90,102-110` | intent_parse | PARTIAL | `skill.intent_type_seed` | Current: trace 有 `type/cz_seed/ez_seed/tags`；Gap: 无 `confidence_breakdown` 与关键词命中列表。 |
| INTENT_NO_CITY_ABORT | `agent_runtime/src/agents/intentAgent.ts:124-126` | routing_guard | NO | `skill.intent_route_guard` | Current: 无 city 时直接 `return null`；Gap: 未输出上游可见 trace（为什么没调用 tool）。 |
| GW_TOOL_INPUT_VALIDATE | `gateway/src/main/java/gateway/GatewayServer.java:329-387` | contract_validation | NO | `skill.gateway_contract_validate` | Current: 返回 400 错误体；Gap: 未写入统一 `decision_trace.gateway.validation`。 |
| GW_MODE_ROUTE | `gateway/src/main/java/gateway/GatewayServer.java:216-241,243-327` | routing | NO | `skill.gateway_route_mode` | Current: dummy/remote/retry/forward 决策在网关内部；Gap: 无结构化 trace 输出 mode/attempt/backend。 |
| GW_RATE_LIMIT | `gateway/src/main/java/gateway/GatewayServer.java:624-634` | rate_limit | NO | `skill.gateway_rate_limit` | Current: 仅日志 + 429；Gap: 无 trace 字段记录 qps 配额与命中窗口。 |
| GW_CIRCUIT_BREAKER | `gateway/src/main/java/gateway/GatewayServer.java:636-655` | resilience | NO | `skill.gateway_circuit_breaker` | Current: 仅状态机与日志；Gap: 无 trace 字段记录 circuit open/close 原因。 |
| ONTOLOGY_NORMALIZE_MAP | `services/ontology/normalize_rules.py:46-135,179-223` | normalization | PARTIAL | `skill.ontology_normalize` | Current: ontology response 自带 `mapping_used/unknown`；Gap: 未并入跨服务 `decision_trace` 主链路。 |
| MEM_SEARCH_METHOD_SWITCH | `services/memory/search.py:245-269` | retrieval_strategy | PARTIAL | `skill.memory_weighted_search` | Current: 每条结果有 `cosine` 等分量；Gap: 缺少 `method=embedding|tag_fallback` 聚合 trace。 |
| MEM_WEIGHTED_SCORE | `services/memory/search.py:271-294` | scoring | PARTIAL | `skill.memory_score_components` | Current: result 有 `w_time/w_sent/w_context`；Gap: 缺 `rule_id/weights_version` 与被截断项说明。 |
| MEM_SEARCH_INPUT_GUARD | `services/memory/main.py:215-219` | input_guard | NO | `skill.memory_query_guard` | Current: 422 抛错；Gap: 无 decision_trace 可回放 guard 触发。 |

## Suggested Trace Schema Snippets

```json
{
  "decision_trace": {
    "recall": {
      "cross_city_guard": {
        "rule_id": "recall_city_guard_v1",
        "rejected_ids": ["osaka_xxx"],
        "rejected_count": 1
      }
    }
  }
}
```

```json
{
  "decision_trace": {
    "rerank": {
      "ez_filter": {
        "rule_id": "ez_taste_distance_guard_v1",
        "threshold": 0.85,
        "rejected": [{"id": "item_1", "taste_distance": 0.91}]
      }
    }
  }
}
```

```json
{
  "decision_trace": {
    "planner": {
      "ez_fill": {
        "rule_id": "planner_ez_fill_v1",
        "triggered": true,
        "source": "excellence_fallback",
        "fill_item_ids": ["tokyo_x1", "tokyo_x2"]
      }
    }
  }
}
```

```json
{
  "decision_trace": {
    "intent_agent": {
      "rule_id": "intent_keywords_v1",
      "city_rule": "CITY_RULES.tokyo",
      "type_hits": ["ramen", "museum"],
      "confidence": 0.8
    }
  }
}
```

```json
{
  "decision_trace": {
    "gateway": {
      "routing": {
        "tool": "planner.compose",
        "mode": "remote",
        "attempt": 1,
        "backend": "planner:/compose"
      }
    }
  }
}
```

```json
{
  "decision_trace": {
    "memory_search": {
      "rule_id": "memory_search_v1_3",
      "method": "embedding",
      "weights": {"lambda_time": 0.03, "alpha_sent": 0.5},
      "top_k": 10
    }
  }
}
```
