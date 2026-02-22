package gateway;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.logging.Level;
import java.util.logging.Logger;

public class GatewayServer {
    private static final Logger LOGGER = Logger.getLogger(GatewayServer.class.getName());
    private static final int PORT = 8080;
    private static final int TIMEOUT_MS = 3000;
    private final Map<String, String> toolModes;
    private final Map<String, String> serviceUrls;
    private final Map<String, ToolRoute> toolRoutes;
    private final Map<String, RateLimiter> rateLimiters;
    private final Map<String, CircuitState> circuitStates;
    private final ExecutorService taskExecutor;
    private HttpServer server;

    public GatewayServer(Path configPath) {
        this.toolModes = loadToolModes(configPath);
        this.serviceUrls = loadServiceUrls(configPath);
        this.toolRoutes = initToolRoutes();
        this.rateLimiters = new ConcurrentHashMap<>();
        this.circuitStates = new ConcurrentHashMap<>();
        this.taskExecutor = Executors.newCachedThreadPool();
    }

    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress(PORT), 0);
        server.createContext("/tool", new ToolHandler());
        server.createContext("/health", new HealthHandler());
        server.createContext("/status", new StatusHandler());
        server.setExecutor(Executors.newCachedThreadPool());
        Runtime.getRuntime().addShutdownHook(new Thread(this::stop));
        server.start();
        LOGGER.info(() -> String.format("Gateway server started on port %d", PORT));
    }

    public void stop() {
        if (server != null) {
            LOGGER.info("Stopping gateway server");
            server.stop(0);
        }
        taskExecutor.shutdownNow();
    }

    private Map<String, String> loadToolModes(Path configPath) {
        if (!Files.exists(configPath)) {
            LOGGER.warning(() -> "Config file not found at " + configPath.toAbsolutePath());
            return Collections.emptyMap();
        }

        try (InputStream inputStream = Files.newInputStream(configPath)) {
            Yaml yaml = new Yaml();
            Object raw = yaml.load(inputStream);
            if (!(raw instanceof Map)) {
                LOGGER.warning("Config file is empty or malformed");
                return Collections.emptyMap();
            }
            Map<?, ?> config = (Map<?, ?>) raw;
            Object modeSection = config.get("mode");
            if (!(modeSection instanceof Map)) {
                LOGGER.warning("Mode section missing or malformed in config");
                return Collections.emptyMap();
            }

            Map<String, String> modes = new HashMap<>();
            ((Map<?, ?>) modeSection).forEach((k, v) -> {
                if (k != null && v != null) {
                    String key = k.toString().trim().toLowerCase();
                    String value = v.toString().trim().toLowerCase();
                    modes.put(key, value);
                }
            });
            LOGGER.info(() -> "Loaded tool modes: " + modes);
            return modes;
        } catch (IOException e) {
            LOGGER.log(Level.SEVERE, "Failed to read config file", e);
            return Collections.emptyMap();
        }
    }

    private Map<String, String> loadServiceUrls(Path configPath) {
        if (!Files.exists(configPath)) {
            LOGGER.warning(() -> "Config file not found at " + configPath.toAbsolutePath());
            return Collections.emptyMap();
        }
        try (InputStream inputStream = Files.newInputStream(configPath)) {
            Yaml yaml = new Yaml();
            Object raw = yaml.load(inputStream);
            if (!(raw instanceof Map)) {
                LOGGER.warning("Config file is empty or malformed");
                return Collections.emptyMap();
            }
            Map<?, ?> config = (Map<?, ?>) raw;
            Object servicesSection = config.get("services");
            if (!(servicesSection instanceof Map)) {
                LOGGER.warning("Services section missing or malformed in config");
                return Collections.emptyMap();
            }
            Map<String, String> services = new HashMap<>();
            ((Map<?, ?>) servicesSection).forEach((k, v) -> {
                if (k != null && v != null) {
                    services.put(k.toString(), v.toString());
                }
            });
            LOGGER.info(() -> "Loaded service URLs: " + services);
            return services;
        } catch (IOException e) {
            LOGGER.log(Level.SEVERE, "Failed to read config file", e);
            return Collections.emptyMap();
        }
    }

    private Map<String, ToolRoute> initToolRoutes() {
        Map<String, ToolRoute> routes = new HashMap<>();
        routes.put("planner.compose", new ToolRoute("planner.compose", "planner", "/compose", 3000, false, true, 10));
        routes.put("ontology.normalize", new ToolRoute("ontology.normalize", "ontology", "/normalize", 3000, true, false, 20));
        routes.put("embedding.generate", new ToolRoute("embedding.generate", "embedding", "/generate", 3000, true, false, 20));
        routes.put("embedding.tes_build", new ToolRoute("embedding.tes_build", "embedding", "/tes/build", 3000, true, false, 20));
        routes.put("vision.describe", new ToolRoute("vision.describe", "vision", "/describe", 5000, true, false, 10));
        routes.put("recommendation.score", new ToolRoute("recommendation.score", "recommendation", "/score", 3000, true, false, 20));
        routes.put("memory.search", new ToolRoute("memory.search", "memory", "/search", 3000, true, true, 30));
        routes.put("memory.read", new ToolRoute("memory.read", "memory", "/read", 2000, true, true, 30));
        return routes;
    }

    private final class ToolHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) {
            long start = System.currentTimeMillis();
            String path = exchange.getRequestURI().getPath();
            String toolName = extractToolName(path);
            String traceId = newTraceId();
            logInfo(traceId, toolName, "incoming", String.format("method=%s path=%s", exchange.getRequestMethod(), path));

            ToolRoute route = (toolName == null) ? null : toolRoutes.get(toolName);
            int timeoutMs = (route != null && route.timeoutMs > 0) ? route.timeoutMs : TIMEOUT_MS;
            // TODO: apply per-tool timeout across all stages more precisely

            Future<ResponseData> future = taskExecutor.submit(() -> processRequest(exchange, toolName, route, traceId));
            ResponseData response;
            try {
                response = future.get(timeoutMs, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                future.cancel(true);
                logWarn(traceId, toolName, "timeout", "request timed out");
                response = ResponseData.timeout();
            } catch (Exception e) {
                logError(traceId, toolName, "error", "error processing request", e);
                response = ResponseData.error();
            }

            writeResponse(exchange, response, traceId);
            long duration = System.currentTimeMillis() - start;
            logInfo(traceId, toolName, "respond", String.format("latency=%dms status=%d", duration, response.statusCode));
        }

        private ResponseData processRequest(HttpExchange exchange, String toolName, ToolRoute route, String traceId) throws IOException {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                return ResponseData.methodNotAllowed();
            }

            if (toolName == null || toolName.isBlank()) {
                return ResponseData.badRequest("Missing tool name");
            }

            if (route == null) {
                return new ResponseData(
                        400,
                        String.format("{\"error\":\"unknown tool\",\"tool\":\"%s\"}", escapeJson(toolName)),
                        "application/json"
                );
            }

            if (!allowByRateLimit(route, traceId)) {
                return new ResponseData(
                        429,
                        String.format("{\"error\":\"rate limit exceeded\",\"tool\":\"%s\"}", escapeJson(toolName)),
                        "application/json"
                );
            }

            byte[] incoming = exchange.getRequestBody().readAllBytes();
            Map<String, Object> payload = parsePayloadMap(incoming);
            ResponseData validationError = validateToolInput(toolName, payload);
            if (validationError != null) {
                return validationError;
            }

            String module = route.serviceKey;

            // Determine mode by module first (config.yaml uses module keys), fallback to full tool name.
            String mode = toolModes.getOrDefault(module, toolModes.get(toolName));
            if (mode == null) {
                return new ResponseData(
                        400,
                        String.format("{\"error\":\"unknown tool\",\"tool\":\"%s\"}", escapeJson(toolName)),
                        "application/json"
                );
            }

            if ("dummy".equalsIgnoreCase(mode)) {
                // Keep dummy responses readable and stable. Special-case a few common tool families.
                if ("memory".equals(module)) {
                    // Stage-2 expects fixed P5 records. If memory service is not started, still return a stable dummy.
                    logInfo(traceId, toolName, "dummy", "returning memory dummy response");
                    return new ResponseData(
                            200,
                            "{\"results\":[{" +
                                    "\"memory_id\":\"p5_tokyo_ramen\",\"user_id\":\"user_123\",\"type\":\"food\",\"city\":\"Tokyo\",\"timestamp\":\"2024-01-05T20:15:00Z\",\"title\":\"Late-night ramen in Shinjuku\",\"notes\":\"Creamy tonkotsu broth with extra chashu; walked from hotel.\",\"tags\":[\"ramen\",\"japan\",\"comfort\"],\"sentiment\":0.87}," +
                                    "{\"memory_id\":\"p5_kyoto_temple\",\"user_id\":\"user_123\",\"type\":\"culture\",\"city\":\"Kyoto\",\"timestamp\":\"2023-11-12T09:30:00Z\",\"title\":\"Morning visit to Fushimi Inari\",\"notes\":\"Hiked through torii gates; quiet and cool.\",\"tags\":[\"culture\",\"walking\",\"japan\"],\"sentiment\":0.91}]}",
                            "application/json"
                    );
                }
                logInfo(traceId, toolName, "dummy", "returning generic dummy response");
                return new ResponseData(200, buildDummyResponse(toolName), "application/json");
            }

            if ("remote".equalsIgnoreCase(mode)) {
                if (isCircuitOpen(route.serviceKey, traceId)) {
                    return new ResponseData(
                            503,
                            String.format("{\"error\":\"circuit open\",\"service\":\"%s\"}", escapeJson(route.serviceKey)),
                            "application/json"
                    );
                }

                String baseUrl = serviceUrls.get(module);
                if (baseUrl == null || baseUrl.isBlank()) {
                    return new ResponseData(
                            500,
                            String.format("{\"error\":\"no configured backend for module\",\"module\":\"%s\"}", escapeJson(module)),
                            "application/json"
                    );
                }

                String serviceUrl = joinUrl(baseUrl, route.path);
                String httpMethod = "POST";
                byte[] forwardedBody = incoming;
                if ("memory.read".equals(toolName)) {
                    String memoryId = extractMemoryId(payload);
                    serviceUrl = joinUrl(baseUrl, "/read/" + urlEncode(memoryId));
                    httpMethod = "GET";
                    forwardedBody = new byte[0];
                } else if ("embedding.tes_build".equals(toolName)) {
                    forwardedBody = buildTesBuildForwardBody(payload);
                }

                // Forward request body to remote microservice
                int attempts = route.retryable ? 3 : 1;
                ResponseData lastResponse = null;

                for (int attempt = 1; attempt <= attempts; attempt++) {
                    boolean lastAttempt = (attempt == attempts);
                    try {
                        java.net.URL url = new java.net.URL(serviceUrl);
                        java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                        conn.setRequestMethod(httpMethod);
                        boolean withBody = !"GET".equalsIgnoreCase(httpMethod);
                        conn.setDoOutput(withBody);
                        conn.setRequestProperty("Content-Type", "application/json");
                        conn.setRequestProperty("X-Trace-Id", traceId);

                        if (withBody) {
                            try (OutputStream os = conn.getOutputStream()) {
                                os.write(forwardedBody);
                            }
                        }

                        int code = conn.getResponseCode();
                        InputStream is = (code >= 200 && code < 300)
                                ? conn.getInputStream()
                                : conn.getErrorStream();

                        String body = (is == null)
                                ? "{\"error\":\"empty response\"}"
                                : new String(is.readAllBytes(), StandardCharsets.UTF_8);

                        lastResponse = new ResponseData(code, body, "application/json");
                        logInfo(traceId, toolName, "forward", String.format("attempt=%d status=%d", attempt, code));

                        if (code >= 200 && code < 300) {
                            recordCircuitSuccess(route.serviceKey, traceId);
                            return lastResponse;
                        }

                        recordCircuitFailure(route.serviceKey, traceId);
                        if (!route.retryable || lastAttempt || code < 500) {
                            return lastResponse;
                        }
                    } catch (IOException e) {
                        logWarn(traceId, toolName, "forward", String.format("attempt=%d network_error=%s", attempt, e.getMessage()));
                        recordCircuitFailure(route.serviceKey, traceId);
                        if (!route.retryable || lastAttempt) {
                            return new ResponseData(
                                    502,
                                    String.format("{\"error\":\"network error\",\"tool\":\"%s\"}", escapeJson(toolName)),
                                    "application/json"
                            );
                        }
                    }
                }

                if (lastResponse != null) {
                    return lastResponse;
                }
                return new ResponseData(502, "{\"error\":\"bad gateway\"}", "application/json");
            }

            return new ResponseData(
                    501,
                    String.format("{\"error\":\"mode '%s' not implemented\",\"tool\":\"%s\"}",
                            escapeJson(mode), escapeJson(toolName)),
                    "application/json"
            );
        }

        private ResponseData validateToolInput(String toolName, Map<String, Object> payload) {
            if (payload == null) {
                return invalidToolInput(
                        toolName,
                        List.of("json_object"),
                        "Request body must be a JSON object"
                );
            }

            List<String> missing = new ArrayList<>();
            switch (toolName) {
                case "planner.compose":
                    if (!hasPath(payload, "data")) {
                        missing.add("data");
                    }
                    break;
                case "ontology.normalize":
                    if (!hasAnyPath(payload, List.of("data", "tags", "data.tags"))) {
                        missing.add("data|tags");
                    }
                    break;
                case "embedding.generate":
                    if (!hasPath(payload, "data")) {
                        missing.add("data");
                    }
                    break;
                case "embedding.tes_build":
                    if (!validateTesBuildPayload(payload, missing)) {
                        return invalidToolInput(
                                toolName,
                                missing,
                                "Provide TES build fields: tags/vision_features/sentiment/recency_days/location (or legacy data.normalized_tags/data.vision_tags)"
                        );
                    }
                    break;
                case "vision.describe":
                    if (!hasAnyPath(payload, List.of("data.image_url", "image_url", "data.image_base64", "image_base64"))) {
                        missing.add("data.image_url|data.image_base64");
                    }
                    break;
                case "recommendation.score":
                    if (!hasAnyPath(payload, List.of("data.user_id", "user_id"))) {
                        missing.add("data.user_id|user_id");
                    }
                    if (!hasAnyPath(payload, List.of("data.city", "city"))) {
                        missing.add("data.city|city");
                    }
                    break;
                case "memory.read":
                    if (!hasAnyPath(payload, List.of("memory_id", "data.memory_id"))) {
                        missing.add("memory_id|data.memory_id");
                    }
                    break;
                case "memory.search":
                    if (!validateMemorySearchPayload(payload, missing)) {
                        return invalidToolInput(
                                toolName,
                                missing,
                                "Provide data.user_id and one of data.query_tags/data.query_embedding"
                        );
                    }
                    break;
                default:
                    return null;
            }

            if (missing.isEmpty()) {
                return null;
            }

            return invalidToolInput(
                    toolName,
                    missing,
                    "Provide required fields in tool input payload"
            );
        }

        private Map<String, Object> parsePayloadMap(byte[] incoming) {
            String raw = new String(incoming == null ? new byte[0] : incoming, StandardCharsets.UTF_8).trim();
            if (raw.isEmpty()) {
                return new HashMap<>();
            }
            try {
                Yaml yaml = new Yaml();
                Object parsed = yaml.load(raw);
                if (parsed instanceof Map<?, ?>) {
                    Map<String, Object> result = new HashMap<>();
                    ((Map<?, ?>) parsed).forEach((k, v) -> {
                        if (k != null) {
                            result.put(k.toString(), v);
                        }
                    });
                    return result;
                }
                return null;
            } catch (Exception e) {
                return null;
            }
        }

        private boolean hasAnyPath(Map<String, Object> payload, List<String> paths) {
            for (String path : paths) {
                if (hasPath(payload, path)) {
                    return true;
                }
            }
            return false;
        }

        @SuppressWarnings("unchecked")
        private boolean hasPath(Map<String, Object> payload, String path) {
            if (payload == null || path == null || path.isBlank()) return false;
            String[] parts = path.split("\\.");
            Object cursor = payload;
            for (String part : parts) {
                if (!(cursor instanceof Map<?, ?>)) return false;
                Map<String, Object> map = (Map<String, Object>) cursor;
                if (!map.containsKey(part)) return false;
                cursor = map.get(part);
            }

            if (cursor == null) return false;
            if (cursor instanceof String) return !((String) cursor).trim().isEmpty();
            if (cursor instanceof List<?>) return !((List<?>) cursor).isEmpty();
            return true;
        }

        private ResponseData invalidToolInput(String toolName, List<String> missing, String hint) {
            String body = String.format(
                    "{\"error\":{\"code\":\"INVALID_TOOL_INPUT\",\"message\":\"invalid input for tool\",\"details\":{\"missing\":%s,\"hint\":\"%s\"}},\"tool\":\"%s\"}",
                    toJsonStringArray(missing),
                    escapeJson(hint),
                    escapeJson(toolName)
            );
            return new ResponseData(400, body, "application/json");
        }

        private boolean validateMemorySearchPayload(Map<String, Object> payload, List<String> missing) {
            Object dataObj = payload.get("data");
            if (!(dataObj instanceof Map<?, ?>)) {
                missing.add("data");
                return false;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> data = (Map<String, Object>) dataObj;
            if (!hasPath(payload, "data.user_id")) {
                missing.add("data.user_id");
            }
            if (!hasAnyPath(payload, List.of("data.query_tags", "data.query_embedding"))) {
                missing.add("data.query_tags|data.query_embedding");
            }
            List<String> allowed = List.of(
                    "user_id", "query_tags", "query_embedding", "city", "top_k", "now_ts"
            );
            List<String> invalid = findUnknownKeys(data, allowed, "data");
            missing.addAll(invalid);
            return missing.isEmpty();
        }

        private boolean validateTesBuildPayload(Map<String, Object> payload, List<String> missing) {
            List<String> allowedRoot = List.of(
                    "vision_features", "tags", "sentiment", "recency_days", "location", "normalize", "data"
            );
            missing.addAll(findUnknownKeys(payload, allowedRoot, "root"));

            boolean hasRootCandidate = hasAnyPath(payload, List.of(
                    "vision_features", "tags", "sentiment", "recency_days", "location"
            ));
            boolean hasLegacyCandidate = hasAnyPath(payload, List.of(
                    "data.vision_tags", "data.normalized_tags", "data.emotion", "data.recency_days"
            ));
            if (!hasRootCandidate && !hasLegacyCandidate) {
                missing.add("tags|vision_features|sentiment|recency_days|location");
            }

            Object dataObj = payload.get("data");
            if (dataObj instanceof Map<?, ?>) {
                @SuppressWarnings("unchecked")
                Map<String, Object> data = (Map<String, Object>) dataObj;
                List<String> allowedData = List.of("vision_tags", "normalized_tags", "emotion", "recency_days");
                missing.addAll(findUnknownKeys(data, allowedData, "data"));
            }
            return missing.isEmpty();
        }

        private List<String> findUnknownKeys(Map<String, Object> payload, List<String> allowed, String prefix) {
            List<String> invalid = new ArrayList<>();
            if (payload == null) return invalid;
            for (String key : payload.keySet()) {
                if (!allowed.contains(key)) {
                    invalid.add(prefix + "." + key);
                }
            }
            return invalid;
        }

        private String extractMemoryId(Map<String, Object> payload) {
            if (payload == null) return "";
            Object direct = payload.get("memory_id");
            if (direct instanceof String && !((String) direct).trim().isEmpty()) {
                return ((String) direct).trim();
            }
            Object dataObj = payload.get("data");
            if (dataObj instanceof Map<?, ?>) {
                Object nested = ((Map<?, ?>) dataObj).get("memory_id");
                if (nested instanceof String && !((String) nested).trim().isEmpty()) {
                    return ((String) nested).trim();
                }
            }
            return "";
        }

        private byte[] buildTesBuildForwardBody(Map<String, Object> payload) {
            Map<String, Object> outgoing = new HashMap<>();
            if (payload != null) {
                copyIfPresent(payload, outgoing, "vision_features");
                copyIfPresent(payload, outgoing, "tags");
                copyIfPresent(payload, outgoing, "sentiment");
                copyIfPresent(payload, outgoing, "recency_days");
                copyIfPresent(payload, outgoing, "location");
                copyIfPresent(payload, outgoing, "normalize");

                Object dataObj = payload.get("data");
                if (dataObj instanceof Map<?, ?>) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> data = (Map<String, Object>) dataObj;
                    if (!outgoing.containsKey("vision_features") && data.get("vision_tags") != null) {
                        outgoing.put("vision_features", data.get("vision_tags"));
                    }
                    if (!outgoing.containsKey("tags") && data.get("normalized_tags") != null) {
                        outgoing.put("tags", data.get("normalized_tags"));
                    }
                    if (!outgoing.containsKey("recency_days") && data.get("recency_days") != null) {
                        outgoing.put("recency_days", data.get("recency_days"));
                    }
                }
            }

            String json = toJson(outgoing);
            return json.getBytes(StandardCharsets.UTF_8);
        }

        private void copyIfPresent(Map<String, Object> from, Map<String, Object> to, String key) {
            if (from.containsKey(key) && from.get(key) != null) {
                to.put(key, from.get(key));
            }
        }

        private String urlEncode(String input) {
            return URLEncoder.encode(Objects.toString(input, ""), StandardCharsets.UTF_8);
        }

        private String toJson(Object value) {
            if (value == null) return "null";
            if (value instanceof String) return "\"" + escapeJson((String) value) + "\"";
            if (value instanceof Number || value instanceof Boolean) return value.toString();
            if (value instanceof List<?>) {
                List<String> parts = new ArrayList<>();
                for (Object item : (List<?>) value) {
                    parts.add(toJson(item));
                }
                return "[" + String.join(",", parts) + "]";
            }
            if (value instanceof Map<?, ?>) {
                List<String> entries = new ArrayList<>();
                for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                    String key = Objects.toString(entry.getKey(), "");
                    entries.add("\"" + escapeJson(key) + "\":" + toJson(entry.getValue()));
                }
                return "{" + String.join(",", entries) + "}";
            }
            return "\"" + escapeJson(value.toString()) + "\"";
        }

        private String toJsonStringArray(List<String> values) {
            if (values == null || values.isEmpty()) return "[]";
            List<String> escaped = new ArrayList<>();
            for (String value : values) {
                escaped.add("\"" + escapeJson(value) + "\"");
            }
            return "[" + String.join(",", escaped) + "]";
        }

        private String buildDummyResponse(String toolName) {
            return "{\n" +
                    "  \"dummy\": true,\n" +
                    "  \"tool\": \"" + escapeJson(toolName) + "\",\n" +
                    "  \"message\": \"dummy response\"\n" +
                    "}";
        }

        private void writeResponse(HttpExchange exchange, ResponseData response, String traceId) {
            try {
                Headers headers = exchange.getResponseHeaders();
                headers.set("Content-Type", response.contentType);
                headers.set("X-Trace-Id", traceId);
                byte[] bytes = response.body.getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(response.statusCode, bytes.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            } catch (IOException e) {
                LOGGER.log(Level.SEVERE, "Failed to write response", e);
            } finally {
                exchange.close();
            }
        }

        private String escapeJson(String value) {
            return Objects.toString(value, "").replace("\\", "\\\\").replace("\"", "\\\"");
        }
    }

    private static final class ResponseData {
        private final int statusCode;
        private final String body;
        private final String contentType;

        private ResponseData(int statusCode, String body, String contentType) {
            this.statusCode = statusCode;
            this.body = body;
            this.contentType = contentType;
        }

        private static ResponseData timeout() {
            return new ResponseData(504, "{\"error\":\"request timeout\"}", "application/json");
        }

        private static ResponseData error() {
            return new ResponseData(500, "{\"error\":\"internal server error\"}", "application/json");
        }

        private static ResponseData methodNotAllowed() {
            return new ResponseData(405, "{\"error\":\"method not allowed\"}", "application/json");
        }

        private static ResponseData badRequest(String message) {
            String body = String.format("{\"error\":\"%s\"}", escape(message));
            return new ResponseData(400, body, "application/json");
        }

        private static String escape(String value) {
            return Objects.toString(value, "").replace("\\", "\\\\").replace("\"", "\\\"");
        }
    }

    private static final class ToolRoute {
        private final String toolName;
        private final String serviceKey;
        private final String path;
        private final int timeoutMs;
        private final boolean retryable;
        private final boolean allowFallback;
        private final int rateLimitQps;

        private ToolRoute(
                String toolName,
                String serviceKey,
                String path,
                int timeoutMs,
                boolean retryable,
                boolean allowFallback,
                int rateLimitQps
        ) {
            this.toolName = toolName;
            this.serviceKey = serviceKey;
            this.path = path;
            this.timeoutMs = timeoutMs;
            this.retryable = retryable;
            this.allowFallback = allowFallback;
            this.rateLimitQps = rateLimitQps;
        }
    }

    private static final class RateLimiter {
        private long windowStartMs;
        private int count;

        private synchronized boolean allow(int qps) {
            if (qps <= 0) return true;
            long now = System.currentTimeMillis();
            if (now - windowStartMs >= 1000) {
                windowStartMs = now;
                count = 0;
            }
            if (count >= qps) {
                return false;
            }
            count++;
            return true;
        }
    }

    private static final class CircuitState {
        private int failureCount;
        private long openUntilMs;

        private synchronized boolean isOpen() {
            return System.currentTimeMillis() < openUntilMs;
        }

        private synchronized void recordSuccess() {
            failureCount = 0;
            openUntilMs = 0;
        }

        private synchronized void recordFailure() {
            failureCount++;
            if (failureCount >= 5) {
                openUntilMs = System.currentTimeMillis() + 30_000;
            }
        }

        private synchronized String status() {
            return isOpen() ? "open" : "closed";
        }
    }

    private final class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) {
            String traceId = newTraceId();
            logInfo(traceId, "health", "health", "status ok");
            ResponseData response = new ResponseData(200, "{\"status\":\"ok\"}", "application/json");
            writeResponse(exchange, response, traceId);
        }
    }

    private final class StatusHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) {
            String traceId = newTraceId();
            List<String> serviceStatuses = new ArrayList<>();
            for (Map.Entry<String, CircuitState> entry : circuitStates.entrySet()) {
                String service = entry.getKey();
                String status = entry.getValue().status();
                serviceStatuses.add(String.format("\"%s\":\"%s\"", escapeJson(service), escapeJson(status)));
            }
            String statusBody = "{"
                    + "\"tool_count\":" + toolRoutes.size() + ","
                    + "\"services\":{" + String.join(",", serviceStatuses) + "},"
                    + "\"time\":\"" + Instant.now() + "\""
                    + "}";
            logInfo(traceId, "status", "status", "reporting status");
            ResponseData response = new ResponseData(200, statusBody, "application/json");
            writeResponse(exchange, response, traceId);
        }
    }

    private boolean allowByRateLimit(ToolRoute route, String traceId) {
        if (route.rateLimitQps <= 0) {
            return true;
        }
        RateLimiter limiter = rateLimiters.computeIfAbsent(route.toolName, k -> new RateLimiter());
        boolean allowed = limiter.allow(route.rateLimitQps);
        if (!allowed) {
            logWarn(traceId, route.toolName, "rate_limit", "rate limit exceeded");
        }
        return allowed;
    }

    private boolean isCircuitOpen(String serviceKey, String traceId) {
        CircuitState state = circuitStates.computeIfAbsent(serviceKey, k -> new CircuitState());
        boolean open = state.isOpen();
        if (open) {
            logWarn(traceId, serviceKey, "circuit", "circuit open");
        }
        return open;
    }

    private void recordCircuitSuccess(String serviceKey, String traceId) {
        CircuitState state = circuitStates.computeIfAbsent(serviceKey, k -> new CircuitState());
        state.recordSuccess();
        logInfo(traceId, serviceKey, "circuit", "circuit closed");
    }

    private void recordCircuitFailure(String serviceKey, String traceId) {
        CircuitState state = circuitStates.computeIfAbsent(serviceKey, k -> new CircuitState());
        state.recordFailure();
        logWarn(traceId, serviceKey, "circuit", "circuit failure recorded");
    }

    private void writeResponse(HttpExchange exchange, ResponseData response, String traceId) {
        try {
            Headers headers = exchange.getResponseHeaders();
            headers.set("Content-Type", response.contentType);
            headers.set("X-Trace-Id", traceId);
            byte[] bytes = response.body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(response.statusCode, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        } catch (IOException e) {
            LOGGER.log(Level.SEVERE, "Failed to write response", e);
        } finally {
            exchange.close();
        }
    }

    private String joinUrl(String base, String path) {
        String b = Objects.toString(base, "").trim();
        String p = Objects.toString(path, "").trim();
        if (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        if (!p.startsWith("/")) p = "/" + p;
        return b + p;
    }

    private String extractToolName(String path) {
        if (path == null) return null;
        if (!path.startsWith("/tool")) return null;
        String[] segments = path.split("/");
        if (segments.length < 3 || segments[2].isEmpty()) {
            return null;
        }
        return String.join(".", java.util.Arrays.copyOfRange(segments, 2, segments.length))
                .trim()
                .toLowerCase();
    }

    private String newTraceId() {
        return UUID.randomUUID().toString();
    }

    private void logInfo(String traceId, String tool, String stage, String message) {
        LOGGER.info(() -> formatLog(traceId, tool, stage, message));
    }

    private void logWarn(String traceId, String tool, String stage, String message) {
        LOGGER.warning(() -> formatLog(traceId, tool, stage, message));
    }

    private void logError(String traceId, String tool, String stage, String message, Exception e) {
        LOGGER.log(Level.SEVERE, formatLog(traceId, tool, stage, message), e);
    }

    private String formatLog(String traceId, String tool, String stage, String message) {
        String safeTool = Objects.toString(tool, "unknown");
        return String.format("[trace_id=%s] [tool=%s] [stage=%s] %s", traceId, safeTool, stage, message);
    }

    private String escapeJson(String value) {
        return Objects.toString(value, "").replace("\\", "\\\\").replace("\"", "\\\"");
    }

    public static void main(String[] args) throws IOException {
        Path configPath = Path.of("config.yaml");
        new GatewayServer(configPath).start();
    }
}
