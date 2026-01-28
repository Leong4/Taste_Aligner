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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
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
    private final ExecutorService taskExecutor;
    private HttpServer server;

    public GatewayServer(Path configPath) {
        this.toolModes = loadToolModes(configPath);
        this.serviceUrls = loadServiceUrls(configPath);
        this.taskExecutor = Executors.newCachedThreadPool();
    }

    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress(PORT), 0);
        server.createContext("/tool", new ToolHandler());
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

    private final class ToolHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) {
            long start = System.currentTimeMillis();
            String path = exchange.getRequestURI().getPath();
            LOGGER.info(() -> String.format("Incoming request %s %s at %s", exchange.getRequestMethod(), path, Instant.now()));

            Future<ResponseData> future = taskExecutor.submit(() -> processRequest(exchange));
            ResponseData response;
            try {
                response = future.get(TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                future.cancel(true);
                LOGGER.log(Level.WARNING, "Request timed out");
                response = ResponseData.timeout();
            } catch (Exception e) {
                LOGGER.log(Level.SEVERE, "Error processing request", e);
                response = ResponseData.error();
            }

            writeResponse(exchange, response);
            long duration = System.currentTimeMillis() - start;
            LOGGER.info(String.format("Responded with %d in %d ms", response.statusCode, duration));
        }

        private ResponseData processRequest(HttpExchange exchange) throws IOException {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                return ResponseData.methodNotAllowed();
            }

            String[] segments = exchange.getRequestURI().getPath().split("/");
            if (segments.length < 3 || segments[2].isEmpty()) {
                return ResponseData.badRequest("Missing tool name");
            }
            String toolName = String.join(".", java.util.Arrays.copyOfRange(segments, 2, segments.length))
                    .trim()
                    .toLowerCase();

            // Support both "module" and "module.action" tool names.
            // Example: "/tool/planner.compose" -> toolName="planner.compose", module="planner"
            String module = toolName;
            String action = "";
            int dot = toolName.indexOf('.');
            if (dot > 0) {
                module = toolName.substring(0, dot);
                action = toolName.substring(dot + 1);
            }

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
                    return new ResponseData(
                            200,
                            "{\"results\":[{" +
                                    "\"memory_id\":\"p5_tokyo_ramen\",\"user_id\":\"user_123\",\"type\":\"food\",\"city\":\"Tokyo\",\"timestamp\":\"2024-01-05T20:15:00Z\",\"title\":\"Late-night ramen in Shinjuku\",\"notes\":\"Creamy tonkotsu broth with extra chashu; walked from hotel.\",\"tags\":[\"ramen\",\"japan\",\"comfort\"],\"sentiment\":0.87}," +
                                    "{\"memory_id\":\"p5_kyoto_temple\",\"user_id\":\"user_123\",\"type\":\"culture\",\"city\":\"Kyoto\",\"timestamp\":\"2023-11-12T09:30:00Z\",\"title\":\"Morning visit to Fushimi Inari\",\"notes\":\"Hiked through torii gates; quiet and cool.\",\"tags\":[\"culture\",\"walking\",\"japan\"],\"sentiment\":0.91}]}",
                            "application/json"
                    );
                }
                return new ResponseData(200, buildDummyResponse(toolName), "application/json");
            }

            if ("remote".equalsIgnoreCase(mode)) {
                String baseUrl = serviceUrls.get(module);
                if (baseUrl == null || baseUrl.isBlank()) {
                    return new ResponseData(
                            500,
                            String.format("{\"error\":\"no configured backend for module\",\"module\":\"%s\"}", escapeJson(module)),
                            "application/json"
                    );
                }

                // Map tool -> service endpoint path
                String endpointPath = resolveEndpointPath(module, action);
                if (endpointPath == null) {
                    return new ResponseData(
                            400,
                            String.format("{\"error\":\"unknown tool action\",\"tool\":\"%s\"}", escapeJson(toolName)),
                            "application/json"
                    );
                }

                String serviceUrl = joinUrl(baseUrl, endpointPath);

                // Forward request body to remote microservice
                byte[] incoming = exchange.getRequestBody().readAllBytes();
                java.net.URL url = new java.net.URL(serviceUrl);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(incoming);
                }

                int code = conn.getResponseCode();
                InputStream is = (code >= 200 && code < 300)
                        ? conn.getInputStream()
                        : conn.getErrorStream();

                String body = (is == null)
                        ? "{\"error\":\"empty response\"}"
                        : new String(is.readAllBytes(), StandardCharsets.UTF_8);

                return new ResponseData(code, body, "application/json");
            }

            return new ResponseData(
                    501,
                    String.format("{\"error\":\"mode '%s' not implemented\",\"tool\":\"%s\"}",
                            escapeJson(mode), escapeJson(toolName)),
                    "application/json"
            );
        }

        private String buildDummyResponse(String toolName) {
            return "{\n" +
                    "  \"dummy\": true,\n" +
                    "  \"tool\": \"" + escapeJson(toolName) + "\",\n" +
                    "  \"message\": \"dummy response\"\n" +
                    "}";
        }

        private void writeResponse(HttpExchange exchange, ResponseData response) {
            try {
                Headers headers = exchange.getResponseHeaders();
                headers.set("Content-Type", response.contentType);
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

        private String resolveEndpointPath(String module, String action) {
            // If action is empty, choose a sensible default.
            String a = (action == null) ? "" : action.trim().toLowerCase();

            switch (module) {
                case "vision":
                    // tool: vision.describe
                    return "/describe";
                case "ontology":
                    // tool: ontology.normalize
                    return "/normalize";
                case "embedding":
                    // tool: embedding.generate
                    return "/generate";
                case "recommendation":
                    // tool: recommendation.score
                    return "/score";
                case "planner":
                    // tool: planner.compose
                    return "/compose";
                case "memory":
                    // tool: memory.write / memory.read / memory.search (MVP uses /write and /read)
                    if (a.isEmpty()) return "/read";
                    if (a.equals("write")) return "/write";
                    if (a.equals("read") || a.equals("search")) return "/read";
                    return null;
                default:
                    return null;
            }
        }

        private String joinUrl(String base, String path) {
            String b = Objects.toString(base, "").trim();
            String p = Objects.toString(path, "").trim();
            if (b.endsWith("/")) b = b.substring(0, b.length() - 1);
            if (!p.startsWith("/")) p = "/" + p;
            return b + p;
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

    public static void main(String[] args) throws IOException {
        Path configPath = Path.of("config.yaml");
        new GatewayServer(configPath).start();
    }
}
