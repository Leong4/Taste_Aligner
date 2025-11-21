# ReAct Flow Specification (Taste Aligner V10) — Part 1–3 (English Version)

This document contains **Part 1 to Part 3** of the English version of the ReAct Flow Specification for Codex reference.

---

## **1. Global ReAct Template**

ReAct (Reason + Act) is the core reasoning framework used by all Agents in Taste Aligner. Every Agent must strictly follow the same structure to ensure stable, debuggable, and controllable execution.

### **1.1 Four-Step ReAct Loop**
Each ReAct step follows the sequence:
```
Thought: internal reasoning (never shown to the user)
Action: <tool_name>
Action Input: { ... JSON payload ... }
Observation: { ... tool result ... }
```
The Agent continues this loop until its termination condition is met.

### **1.2 Hard Rules for ReAct**
1. Thought must **never** contain JSON.
2. Action must strictly follow:
```
Action: <tool_name>
```
3. Action Input must be valid JSON exactly matching Tool Registry.
4. Observation must be taken **as-is**, without modification.
5. Each step may call **only one** tool.
6. If Observation contains `error: true`, the Agent must trigger recovery flow.
7. Termination must be explicit using **Final Answer**.

### **1.3 ReAct Example (Correct Format)**
```
Thought: I need to extract the destination city from the query.
Action: parser.extract_destination
Action Input: {"query": "I want to visit Osaka next week"}
Observation: {"city": "Osaka", "country": "Japan"}

Thought: Destination acquired. Passing control to Taste Analyzer.
Final Answer: {"next_agent": "taste_analyzer_agent", "destination": {...}}
```

### **1.4 Purpose of a Unified Template**
- Ensures predictable multi-Agent behavior
- Enables Codex to generate consistent Agent code
- Makes debugging easy by stabilizing the chain-of-thought format
- Ensures Gateway → Tools → Agent remain aligned

---

## **2. Multi-Agent Collaboration Flow**

Taste Aligner contains four main Agents:
- **Intent Agent** – identifies the destination & task type
- **Taste Analyzer Agent** – builds the Taste Profile (TES embedding)
- **Matcher Agent** – computes CZ/EZ recommendations
- **Planner Agent** – composes the final Journey Card

### **2.1 Global Execution Order**
```
User Input → Intent Agent
                ↓
         Taste Analyzer Agent
                ↓
            Matcher Agent
                ↓
            Planner Agent
                ↓
         Final Journey Card
```

This order is strict unless error-recovery requires retrying within the same Agent.

---

## **2.2 Intent Agent**

### Purpose:
- Extract destination city
- Determine task type (food / scenery / mixed)
- Trigger vision flow if images are provided

### Output:
```
{
  "next_agent": "taste_analyzer_agent",
  "context": {
      "destination": {...},
      "task_type": "food" | "scenery" | "mixed"
  },
  "status": "ok"
}
```

---

## **2.3 Taste Analyzer Agent**

### Purpose:
- Process uploaded images
- Normalize labels
- Generate TES embedding via `embedding.generate`

### Output:
```
{
  "next_agent": "matcher_agent",
  "context": {
      "destination": {...},
      "task_type": "food" | "scenery" | "mixed",
      "taste_profile": number[]
  },
  "status": "ok"
}
```

---

## **2.4 Matcher Agent**

### Purpose:
- Retrieve candidate items
- Score via `recommendation.score`
- Return CZ/EZ lists

### Output:
```
{
  "next_agent": "planner_agent",
  "context": {
      "cz_list": [...],
      "ez_list": [...],
      "destination": {...}
  },
  "status": "ok"
}
```

---

## **2.5 Planner Agent (Final Agent)**

### Purpose:
- Fetch memory anchors
- Compose Journey Card via `planner.compose`

### Final Output:
```
{
  "status": "success",
  "journey_card": {...}
}
```

---

## **2.6 Hard Rules for Agent Switching**
1. Every Agent must output `next_agent` (except Planner).
2. No skipping or reordering Agents.
3. Only Planner may return Final Answer.
4. If errors occur → stay within current Agent until resolved.

---

## **3. Agent I/O & Internal State Rules**

### **3.1 Common Input Schema**
```
{
  "context": {...},
  "user_query": string,
  "history": [...],
  "images": string[] | null
}
```

### **3.2 Common Output Schema**
```
{
  "next_agent": string | null,
  "context": {...},
  "status": "ok" | "error",
  "message": string | null
}
```

---

## **3.3 Internal State Rules**
### Allowed:
- Temporary tool results
- Retrieved intermediate data
- Local flags (e.g., "need_destination")

### Forbidden:
- User entire history
- Other Agents’ state
- Gateway internals
- Unvalidated JSON structures

---

## **3.4 Agent Termination Conditions**
Terminate when:
1. All required information is collected
2. Required tool calls succeed
3. Agent's responsibility is complete

Fatal termination when:
- Max loop (12) exceeded
- Too many tool errors (3)
- Essential fields missing

---


# **4. Error Handling & Recovery Mechanism**

A multi-Agent system requires robust error recovery to maintain stability across the entire pipeline. Taste Aligner enforces strict rules for:
- Error categorization
- Retry logic
- Fallback strategies
- Fatal termination
- Logging of error context

---

## **4.1 Three Categories of Errors**

### **(1) Tool-Level Errors (Observation.error = true)**
Tool Registry defines the exact error format:
```
{
  "error": true,
  "message": string,
  "code": string
}
```
Examples:
- VISION_TIMEOUT
- EMBEDDING_DIM_ERROR
- ONTOLOGY_TAG_NOT_FOUND
- SCORE_MODEL_FAIL

### **(2) Agent-Level Errors**
Examples:
- missing essential fields (destination = null)
- JSON parsing failure
- ReAct loop exceeded limit

### **(3) Gateway-Level Errors**
Examples:
- SERVICE_UNAVAILABLE
- INTERNAL_TIMEOUT
- CIRCUIT_BREAK

---

## **4.2 Error Severity Levels**
Taste Aligner defines three severity levels:

### **Level 1 — Recoverable**
- transient tool failures
- missing style/sentiment
- retryable API issues

Action: **retry → fallback → continue**

### **Level 2 — Partially Recoverable**
- missing non-essential fields
- partial tool unavailability

Action: **fallback → continue**

### **Level 3 — Fatal**
- multiple retries failing
- essential information missing
- invalid JSON structure

Action: **abort → return Final Answer with error**

---

## **4.3 Tool Recovery Process**
Upon receiving:
```
{"error": true, ...}
```
Agent must:
1. Identify severity level.
2. Retry up to **2 times**.
3. If still failing → apply fallback logic.
4. If fallback not possible → escalate as fatal.

---

## **4.4 Agent-Level Recovery Process**
If an Agent logic error occurs:
- reset local state (soft reset)
- restart ReAct loop using previous context
- maximum **2 soft resets** allowed

If still failing → return fatal error.

---

## **4.5 Gateway Recovery Rules**
Gateway performs:
1. One retry
2. Fallback response (cached/default)
3. Forward error to Agent if still failing

Agents do **not** handle traffic concerns; only Gateway does.

---

## **4.6 Error Context Logging (Mandatory)**
Every error must be logged:
```
[ERROR] <timestamp> | trace=<id> | agent=<name> | tool=<name> |
code=<error_code> | retry=<n> | fallback=<yes/no>
```

---

## **4.7 Example: vision.describe Timeout**
```
Thought: The image may have failed to load; calling vision.describe.
Action: vision.describe
Action Input: {"image_path": "./photos/1.png"}
Observation: {"error": true, "code": "VISION_TIMEOUT"}

Thought: Recoverable error. Retrying.
...
Observation: {"error": true}

Thought: Using fallback CLIP model.
Action: vision.describe_fallback
Observation: {"labels": [...], "type": "food"}
```

---

# **5. Thought Rules & Safety Constraints**

To ensure controllable ReAct execution and prevent prompt injection, the Thought component follows strict safety rules.

---

## **5.1 Thought Design Rules**
1. **No JSON allowed** in Thought.
2. Thought must only describe reasoning, not execution.
3. Thought must not generate user-visible content.
4. Thought must explain the choice of next tool.
5. Thought must not perform tasks of other Agents.

---

## **5.2 Action Safety Rules**
1. Action name must exactly match Tool Registry.
2. Action Input must strictly follow tool schema.
3. No extra fields or comments allowed.

---

## **5.3 Observation Safety Rules**
- Must accept tool output as-is.
- No rewriting or annotation.

---

## **5.4 ReAct Loop Limits**
- Max 12 steps
- Max 2 retries per tool
- Error triggers recovery or termination

---

## **5.5 Anti–Prompt-Injection Rules**
- Agent may never echo structured parts of user input
- Intent Agent must sanitize malicious strings
- Tools must interpret structure, not LLM

---

## **5.6 Debug Logging Rules**
```
[REACT] step=<n> | agent=<name> | trace=<id> |
thought="..." | action=<tool> | status=<ok/error>
```

---

## **5.7 Summary**
- Thought = pure reasoning
- Action = strict tool invocation
- Observation = raw tool response
- Safety rules prevent chain-of-thought drift

---

# **6. Unified JSON Schema for Action / Observation**

Standardized schemas ensure consistent communication across Agents, Gateway, and microservices.

---

## **6.1 Action Input Schema**
Internal structure:
```
{
  "tool": string,
  "payload": { ... }
}
```
In ReAct:
```
Action Input: { ...payload... }
```

Gateway must validate required fields and types.

---

## **6.2 Observation Schema**
Normal result:
```
Observation: { ...data... }
```
Internal wrapper:
```
{ "status": "ok", "data": {...} }
```

Error format:
```
{"error": true, "message": string, "code": string}
```

---

## **6.3 JSON Schema Storage**
Schemas must be stored in:
```
Taste_Aligner/docs/schemas/
```
Example:
```
memory.search.json
vision.describe.json
...
```

---

## **6.4 ReAct Example with Schema Alignment**
```
Thought: I need to score candidate items.
Action: recommendation.score
Action Input: {
  "user_embedding": [...],
  "candidate_items": [...],
  "mode": "mixed"
}
Observation: {"comfort_zone": [...], "exploration_zone": [...], "debug": {...}}
```

---

## **6.5 Summary**
- Tools must have JSON Schema
- Gateway validates Action Input
- Agent Runtime validates Observation
- Schema ensures stable Codex code generation

---

(End of Part 4–6. Next document will contain Part 7.)


# **7. Logging, Observability & Trace Specification**

This chapter defines the full observability system for Taste Aligner V10.  
All Agents, Gateway, and microservices must follow these logging and tracing rules to ensure debuggability, stability, and full end‑to‑end transparency.

---

## **7.1 Global Trace ID (Mandatory)**
Every user request must generate a global `trace_id`.  
It must propagate across:
- Frontend
- Agent Runtime (Node.js)
- Gateway (Java)
- All microservices (Python/Node)

### **7.1.1 Trace ID Format**
```
<timestamp>-<8_HEX>
Example: 20250204T220314-3F91A2BC
```

### **7.1.2 Propagation Rules**
1. Frontend generates `trace_id`.
2. Sent to Agent Runtime inside request body/header.
3. Gateway forwards `trace_id` inside headers.
4. Microservices read `trace_id` and log it.

All logs must include the same `trace_id`.

---

## **7.2 Logging Levels**
Taste Aligner uses four log levels:

| Level | Purpose |
|-------|---------|
| INFO  | High-level events (Agent switching, pipeline start/end) |
| DEBUG | ReAct details (Thought/Action/Observation) |
| WARN  | Recoverable errors (Level 1/2) |
| ERROR | Fatal errors (Level 3) |

Every log entry must include: timestamp, trace_id, agent/service name.

---

## **7.3 Agent Runtime Logging Rules (Core Component)**
The Agent Runtime is responsible for the most detailed logs.

### **7.3.1 ReAct Step Log (Mandatory)**
```
[REACT] step=<n> | agent=<name> | trace=<id> |
thought="..." | action=<tool> | status=<ok|error>
```

### **7.3.2 Action Input Log (DEBUG mode optional)**
```
[REACT_ACTION] agent=<name> | trace=<id> |
payload=<JSON>
```

### **7.3.3 Observation Log**
```
[REACT_OBSERVE] agent=<name> | trace=<id> |
observation=<JSON>
```

### **7.3.4 Agent Switching Log**
```
[AGENT_SHIFT] from=<agentA> → to=<agentB> | trace=<id>
```

---

## **7.4 Gateway Logging Rules**
Gateway handles traffic governance and must log all tool requests.

### **7.4.1 Successful Tool Call**
```
[GATEWAY] tool=<name> | status=success | trace=<id> |
latency=<ms> | target_service=<service>
```

### **7.4.2 Timeout / Circuit Break Logs**
```
[GATEWAY] tool=<name> | status=timeout | trace=<id> |
retry=<n> | circuit=<open|close>
```

### **7.4.3 Service Unreachable**
```
[GATEWAY] tool=<name> | status=unreachable | trace=<id> |
service=<microservice_name>
```

### **7.4.4 Schema Validation Failure**
```
[GATEWAY] tool=<name> | status=bad_schema | trace=<id> |
reason=<msg>
```

---

## **7.5 Microservice Logging Rules**
Each microservice must produce at least two types of logs.

### **7.5.1 Base Log**
```
[SERVICE] name=<service> | trace=<id> |
route=<path> | latency=<ms>
```

### **7.5.2 Error Log (Mandatory)**
```
[SERVICE_ERROR] service=<name> | trace=<id> |
code=<error_code> | message=<msg>
```

### **7.5.3 Debug Log (Optional)**
```
[SERVICE_DEBUG] <custom_debug_info>
```

---

## **7.6 Frontend Logging Rules**
Frontend logs are essential for reproducing user issues.

```
[FRONTEND] event=<generate_journey_card> | trace=<id> |
images=<n>
```

---

## **7.7 Observability Extensions (Future Enhancements)**
These features are recommended as future improvements:

### **(1) Latency Heatmap**
Visualize which services or tools are slowest.

### **(2) Agent Flow Timeline**
Display each Thought → Action → Observation step on a time axis.

### **(3) Error Dashboard**
Track frequencies of:
- Tool errors
- Gateway timeouts
- Agent soft resets

---

## **7.8 Summary of Observability System**
The Observability Layer ensures:
- Full traceability (frontend → agent → gateway → microservice)
- ReAct chain transparency
- Debuggable error flows
- Consistent logs across languages
- Future readiness for dashboards and metrics

This completes **Part 7** of the English ReAct Flow Specification.

---


