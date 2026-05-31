# City Detection Fix Report

## Scope
- Modified only:
  - `agent_runtime/src/skills/extract_intent.ts`
  - `agent_runtime/src/core/graph_definition.ts`
- Did not modify recommendation, memory, vision, or UI modules.

## What Changed

### 1) Expanded `CITY_RULES`
Extended city regex coverage in `extract_intent.ts` to include:
- Existing: `london`, `tokyo`, `kyoto`, `osaka`, `madrid`, `barcelona`, `munich`, `berlin`
- Added: `guangzhou`, `shanghai`, `beijing`, `chengdu`, `shenzhen`, `hangzhou`
- Added: `paris`, `rome`, `milan`, `naples`, `vienna`, `prague`, `budapest`, `amsterdam`
- Added: `new york`, `los angeles`, `san francisco`, `singapore`, `bangkok`, `seoul`

All rules use case-insensitive word-boundary regex (for example, `/\\bguangzhou\\b/i`, `/\\bnew york\\b/i`).

### 2) Added `input.city` fallback
In `extract_intent.ts`:
- `let city = detectCity(text)`
- If detection fails and `input.city` exists:
  - `city = input.city.toLowerCase().trim()`

Fallback is only applied when text detection fails.

### 3) Wired `input.city` into graph
In `graph_definition.ts`, node `extract_intent.inputFrom` now includes:
- `city: "input.city"`

### 4) Terminal behavior retained
`no_city_detected` terminal logic was not changed.
Because fallback can now set `city`, terminal is naturally avoided when `input.city` is provided.

## Validation

### Startup
```bash
./scripts/dev_down.sh
ollama serve &
./scripts/dev_up.sh --with-llm --with-vision
```

### Query checks
Run:
```bash
curl -sS -X POST http://localhost:8787/run \
  -H 'Content-Type: application/json' \
  -d '{"text":"Plan a relaxing day in Guangzhou","user_id":"city_fix_test"}'

curl -sS -X POST http://localhost:8787/run \
  -H 'Content-Type: application/json' \
  -d '{"text":"Plan a relaxing day in Shanghai","user_id":"city_fix_test"}'

curl -sS -X POST http://localhost:8787/run \
  -H 'Content-Type: application/json' \
  -d '{"text":"Plan a relaxing day in Chengdu","user_id":"city_fix_test"}'

curl -sS -X POST http://localhost:8787/run \
  -H 'Content-Type: application/json' \
  -d '{"text":"Plan a relaxing day in Barcelona","user_id":"city_fix_test"}'
```

Expected:
- `decision_trace.extract_intent.city != null`
- No `pipeline_terminated: no_city_detected`

### Fallback check (`input.city`)
Example:
```bash
curl -sS -X POST http://localhost:8787/run \
  -H 'Content-Type: application/json' \
  -d '{"text":"Plan a relaxing day with no explicit location","city":"Guangzhou","user_id":"city_fix_test"}'
```

Expected:
- `decision_trace.extract_intent.city == "guangzhou"`
- No terminal.

### Log check
```bash
rg -n "pipeline_terminated|no_city_detected" logs/agent_runtime.log
```

For the validation queries above, `terminalReason=no_city_detected` should no longer appear.

## Local Skill-Level Evidence (executed)
Direct `extract_intent` execution after patch:
- `Plan a relaxing day in Guangzhou` -> `city=guangzhou`, `terminal=false`
- `Plan a relaxing day in Shanghai` -> `city=shanghai`, `terminal=false`
- `Plan a relaxing day in Chengdu` -> `city=chengdu`, `terminal=false`
- `Plan a relaxing day in Barcelona` -> `city=barcelona`, `terminal=false`
- `Plan a relaxing day with no explicit location` + `input.city=Guangzhou` -> `city=guangzhou`, `terminal=false`

