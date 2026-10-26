// Pure core: every user-facing setting in one place, loaded from config.ini
// with environment variables as a fallback (keeps setx-based setups working).
//
// Precedence: config.ini (non-empty value) > environment variable > default.
// API keys are stored encrypted by the app (Windows DPAPI, "dpapi:..." values);
// decryption is injected so this file stays platform-free and testable.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "rtai/ini.hpp"
#include "rtai/text_util.hpp"

namespace rtai {

struct Settings {
    // [deepgram]
    std::string deepgram_key;
    std::string language{"multi"};
    std::vector<std::string> keyterms;
    int endpointing_ms{300};
    // language=multi: languages to bias detection toward (Deepgram language_hint).
    std::vector<std::string> language_hints{"pt", "en"};
    // [turn] optional tuning of turn closing (-1 = engine default).
    int turn_boundary_grace_ms{-1};
    int turn_stale_ms{-1};
    int turn_speculative_pause_ms{-1};
    // [llm]
    std::string llm_key;
    std::string llm_url{"https://openrouter.ai/api/v1/chat/completions"};
    std::string model{"qwen-3.8-27b"};
    std::string cerebras_key;
    std::string groq_key;
    std::string reasoning{"minimal"}; // empty = don't send
    int max_tokens{1500};
    double temperature{0.3};
    bool auto_suggest{true};
    std::vector<std::string> keywords; // empty = built-in list
    int cooldown_s{2};
    std::string context_file;
    // [audio]
    bool mic_enabled{true};
    bool loopback_enabled{true};
    std::string vad{"silero"};      // "silero" | "energia"
    std::string silero_model;       // empty = silero_vad.onnx next to the exe
    double energy_threshold{0.01};
    // [rag] hybrid retrieval: BM25 + local multilingual-e5 embeddings.
    // Only active when the model is present (builds with RTAI_ENABLE_EMBEDDINGS).
    bool rag_hybrid{true};
    std::string embed_model_dir;    // empty = %LOCALAPPDATA%\RealTimeAI\models\multilingual-e5-small
    int embed_budget_ms{12};        // longest a question waits for its embedding (0 = never waits)
    double embed_min_score{0.80};   // minimum cosine for a match found only by meaning
    int embed_threads{2};
    // [overlay]
    int overlay_width{860};
    int overlay_max_height_pct{60};
    // [sessao]
    bool save_sessions{true};
    std::string session_dir;        // empty = %LOCALAPPDATA%\RealTimeAI\sessions
    std::string last_agent;
    // [stealth]
    bool stealth_dock{true};
    bool stealth_activity_monitor{true};
    bool stealth_click_through{false};
    bool stealth_screen_capture{true};
    // [calendario]
    std::string calendar_ics_url;
    std::string calendar_token;

    // Problems found while loading (shown in the overlay/console).
    std::vector<std::string> warnings;
    // Where each API key came from: "config.ini", "variável de ambiente" or "".
    std::string deepgram_key_source;
    std::string llm_key_source;
};

constexpr const char* kSecretPrefix = "dpapi:";

inline bool is_protected_secret(std::string_view v) {
    return v.substr(0, 6) == kSecretPrefix;
}

using EnvLookup = std::function<std::string(const char* name)>;
// Returns the plaintext for a "dpapi:..." value, or nullopt if it can't be
// decrypted (file copied from another Windows user/PC).
using SecretDecoder = std::function<std::optional<std::string>(const std::string& protected_value)>;

namespace detail {

inline int clamp_int(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

inline std::optional<int> to_int(const std::string& s) {
    try {
        std::size_t used = 0;
        const int v = std::stoi(s, &used);
        if (used != text::trim(s).size()) return std::nullopt;
        return v;
    } catch (...) {
        return std::nullopt;
    }
}

inline std::optional<double> to_double(std::string s) {
    for (char& c : s) {
        if (c == ',') c = '.'; // "0,3" also accepted
    }
    try {
        std::size_t used = 0;
        const double v = std::stod(s, &used);
        if (used != text::trim(s).size()) return std::nullopt;
        return v;
    } catch (...) {
        return std::nullopt;
    }
}

} // namespace detail

inline Settings load_settings(const ini::File& f, const EnvLookup& env, const SecretDecoder& decode) {
    Settings s;
    auto str = [&](const char* sec, const char* key, const char* env_name, std::string& out) -> bool {
        if (auto v = f.get_nonempty(sec, key)) {
            out = *v;
            return true;
        }
        if (env_name && env) {
            const std::string e = env(env_name);
            if (!e.empty()) {
                out = e;
                return true;
            }
        }
        return false;
    };
    auto boolean = [&](const char* sec, const char* key, const char* env_name, bool& out) {
        std::string raw;
        if (!str(sec, key, env_name, raw)) return;
        if (auto b = ini::parse_bool(raw)) out = *b;
        else s.warnings.push_back(std::string("[") + sec + "] " + key + ": use sim/nao or yes/no (\"" + raw + "\")");
    };
    auto integer = [&](const char* sec, const char* key, int lo, int hi, int& out) {
        std::string raw;
        if (!str(sec, key, nullptr, raw)) return;
        if (auto v = detail::to_int(raw)) out = detail::clamp_int(*v, lo, hi);
        else s.warnings.push_back(std::string("[") + sec + "] " + key + ": invalid number (\"" + raw + "\")");
    };
    auto secret_named = [&](const char* sec, const char* key, const char* env_name,
                            std::string& out, std::string& source) {
        if (auto v = f.get_nonempty(sec, key)) {
            if (is_protected_secret(*v)) {
                auto plain = decode ? decode(*v) : std::nullopt;
                if (plain) {
                    out = *plain;
                    source = "config.ini";
                } else {
                    s.warnings.push_back(std::string("[") + sec + "] " + key +
                                         " could not be decrypted (config from another "
                                         "user/PC?). Paste the key again.");
                }
            } else {
                out = *v;
                source = "config.ini";
            }
            if (!out.empty()) return;
        }
        if (env) {
            const std::string e = env(env_name);
            if (!e.empty()) {
                out = e;
                source = "environment variable";
            }
        }
    };
    auto secret = [&](const char* sec, const char* env_name, std::string& out, std::string& source) {
        secret_named(sec, "api_key", env_name, out, source);
    };

    secret("deepgram", "DEEPGRAM_API_KEY", s.deepgram_key, s.deepgram_key_source);
    str("deepgram", "idioma", "RTAI_DG_LANGUAGE", s.language);
    {
        std::string terms;
        if (str("deepgram", "termos", "RTAI_DG_KEYTERMS", terms)) s.keyterms = text::split_list(terms);
    }
    integer("deepgram", "endpointing_ms", 0, 5000, s.endpointing_ms);
    {
        std::string hints;
        if (str("deepgram", "dicas_idioma", "RTAI_DG_LANGUAGE_HINTS", hints)) {
            s.language_hints = text::split_list(hints);
            const std::string f = text::fold(text::trim(hints));
            if (f == "nenhuma" || f == "off" || f == "nao") s.language_hints.clear();
        }
    }
    // turn-closing tuning (optional, not in template)
    integer("turn", "speculative_pause_ms", 0, 3000, s.turn_speculative_pause_ms);
    integer("turn", "boundary_grace_ms", 0, 3000, s.turn_boundary_grace_ms);
    integer("turn", "stale_ms", 200, 10000, s.turn_stale_ms);

    secret("llm", "OPENROUTER_API_KEY", s.llm_key, s.llm_key_source);
    {
        std::string source;
        secret_named("llm", "cerebras_api_key", "CEREBRAS_API_KEY", s.cerebras_key, source);
        secret_named("llm", "groq_api_key", "GROQ_API_KEY", s.groq_key, source);
    }
    str("llm", "url", "RTAI_LLM_URL", s.llm_url);
    str("llm", "modelo", "RTAI_LLM_MODEL", s.model);
    // Provider model routing and canonical ID normalization:
    // If an OpenRouter key is present, map short names to canonical OpenRouter IDs so OpenRouter routes them.
    if (!s.llm_key.empty()) {
        if (s.model == "llama-3.3-70b") {
            s.model = "meta-llama/llama-3.3-70b-instruct";
        } else if (s.model == "gpt-oss-120b" && s.cerebras_key.empty()) {
            s.model = "qwen/qwen-2.5-72b-instruct";
        }
    } else if (s.cerebras_key.size() > 0 && s.llm_key.empty() && s.model == "llama-3.3-70b") {
        // Cerebras retired the old standalone llama-3.3-70b endpoint; fall back to fast qwen
        s.model = "qwen-3.8-27b";
    }
    if (str("llm", "raciocinio", "RTAI_LLM_REASONING", s.reasoning)) {
        const std::string r = text::fold(s.reasoning);
        if (r == "off" || r == "desligado" || r == "nenhum") s.reasoning.clear();
    }
    integer("llm", "max_tokens", 64, 4000, s.max_tokens);
    {
        std::string raw;
        if (str("llm", "temperatura", nullptr, raw)) {
            if (auto t = detail::to_double(raw); t && *t >= 0.0 && *t <= 2.0) s.temperature = *t;
            else s.warnings.push_back("[llm] temperatura: use a number between 0 and 2");
        }
    }
    boolean("llm", "sugestao_automatica", "RTAI_AUTO_SUGGEST", s.auto_suggest);
    boolean("llm", "auto_sugerir", "RTAI_AUTO_SUGGEST", s.auto_suggest);
    boolean("llm", "auto_suggest", "RTAI_AUTO_SUGGEST", s.auto_suggest);
    {
        std::string kw;
        if (str("llm", "palavras_chave", "RTAI_KEYWORDS", kw)) s.keywords = text::split_list(kw);
    }
    integer("llm", "intervalo_minimo_s", 0, 120, s.cooldown_s);
    integer("llm", "intervalo_s", 0, 120, s.cooldown_s);
    integer("llm", "cooldown_s", 0, 120, s.cooldown_s);
    str("llm", "arquivo_contexto", "RTAI_CONTEXT_FILE", s.context_file);

    boolean("audio", "microfone", nullptr, s.mic_enabled);
    boolean("audio", "audio_sistema", nullptr, s.loopback_enabled);
    boolean("audio", "sistema", nullptr, s.loopback_enabled);
    boolean("audio", "loopback", nullptr, s.loopback_enabled);
    {
        std::string v;
        if (str("audio", "vad", nullptr, v)) {
            const std::string fv = text::fold(text::trim(v));
            if (fv == "silero" || fv == "energia") s.vad = fv;
            else s.warnings.push_back("[audio] vad: use silero or energia");
        }
    }
    str("audio", "silero_modelo", "RTAI_SILERO_MODEL", s.silero_model);
    {
        std::string raw;
        if (str("audio", "limiar_energia", nullptr, raw)) {
            if (auto t = detail::to_double(raw); t && *t > 0.0 && *t < 1.0) s.energy_threshold = *t;
            else s.warnings.push_back("[audio] limiar_energia: use a number between 0 and 1 (e.g. 0.01)");
        }
    }

    boolean("rag", "hibrido", "RTAI_RAG_HYBRID", s.rag_hybrid);
    str("rag", "modelo_embeddings", "RTAI_EMBED_MODEL_DIR", s.embed_model_dir);
    integer("rag", "orcamento_ms", 0, 100, s.embed_budget_ms);
    integer("rag", "threads", 1, 8, s.embed_threads);
    {
        std::string raw;
        if (str("rag", "similaridade_minima", nullptr, raw)) {
            if (auto t = detail::to_double(raw); t && *t > 0.0 && *t < 1.0) s.embed_min_score = *t;
            else s.warnings.push_back("[rag] similaridade_minima: use a number between 0 and 1 (e.g. 0.80)");
        }
    }

    integer("overlay", "largura", 420, 1100, s.overlay_width);
    integer("overlay", "altura_max_pct", 20, 95, s.overlay_max_height_pct);

    boolean("sessao", "salvar", nullptr, s.save_sessions);
    str("sessao", "pasta", "RTAI_SESSION_DIR", s.session_dir);
    str("sessao", "ultimo_agente", nullptr, s.last_agent);

    // [stealth]
    boolean("stealth", "invisivel_barra_tarefas", "RTAI_STEALTH_DOCK", s.stealth_dock);
    boolean("stealth", "dock", "RTAI_STEALTH_DOCK", s.stealth_dock);
    boolean("stealth", "taskbar", "RTAI_STEALTH_DOCK", s.stealth_dock);

    boolean("stealth", "invisivel_gerenciador", "RTAI_STEALTH_MONITOR", s.stealth_activity_monitor);
    boolean("stealth", "activity_monitor", "RTAI_STEALTH_MONITOR", s.stealth_activity_monitor);
    boolean("stealth", "task_manager", "RTAI_STEALTH_MONITOR", s.stealth_activity_monitor);

    boolean("stealth", "clique_atravessa", "RTAI_STEALTH_CLICK_THROUGH", s.stealth_click_through);
    boolean("stealth", "click_through", "RTAI_STEALTH_CLICK_THROUGH", s.stealth_click_through);

    boolean("stealth", "invisivel_gravacao", "RTAI_STEALTH_SCREEN_CAPTURE", s.stealth_screen_capture);
    boolean("stealth", "screen_capture", "RTAI_STEALTH_SCREEN_CAPTURE", s.stealth_screen_capture);

    str("calendario", "url_ics", "RTAI_CALENDAR_ICS", s.calendar_ics_url);
    {
        std::string source;
        secret_named("calendario", "token", "RTAI_CALENDAR_TOKEN", s.calendar_token, source);
    }

    if (!s.mic_enabled && !s.loopback_enabled) {
        s.warnings.push_back("[audio] microfone and audio_sistema are both off: nothing will be captured");
    }
    return s;
}

// Commented template written on first run.
// Keys the UI may write through set_config (config.ini sections/keys).
inline bool is_known_setting(std::string_view section, std::string_view key) {
    struct K { const char* s; const char* k; };
    static constexpr K known[] = {
        {"deepgram", "api_key"}, {"deepgram", "idioma"}, {"deepgram", "termos"}, {"deepgram", "endpointing_ms"},
        {"deepgram", "dicas_idioma"},
        {"llm", "api_key"}, {"llm", "cerebras_api_key"}, {"llm", "groq_api_key"}, {"llm", "url"}, {"llm", "modelo"}, {"llm", "raciocinio"}, {"llm", "max_tokens"},
        {"llm", "temperatura"}, {"llm", "sugestao_automatica"}, {"llm", "auto_sugerir"}, {"llm", "auto_suggest"}, {"llm", "palavras_chave"},
        {"llm", "intervalo_minimo_s"}, {"llm", "intervalo_s"}, {"llm", "cooldown_s"}, {"llm", "arquivo_contexto"}, {"llm", "host"},
        {"turn", "speculative_pause_ms"}, {"turn", "boundary_grace_ms"}, {"turn", "stale_ms"},
        {"audio", "microfone"}, {"audio", "audio_sistema"}, {"audio", "sistema"}, {"audio", "loopback"}, {"audio", "vad"}, {"audio", "silero_modelo"},
        {"audio", "limiar_energia"},
        {"rag", "hibrido"}, {"rag", "modelo_embeddings"}, {"rag", "orcamento_ms"}, {"rag", "threads"}, {"rag", "similaridade_minima"},
        {"overlay", "largura"}, {"overlay", "altura_max_pct"},
        {"sessao", "salvar"}, {"sessao", "pasta"}, {"sessao", "ultimo_agente"},
        {"stealth", "invisivel_barra_tarefas"}, {"stealth", "dock"}, {"stealth", "taskbar"},
        {"stealth", "invisivel_gerenciador"}, {"stealth", "activity_monitor"}, {"stealth", "task_manager"},
        {"stealth", "clique_atravessa"}, {"stealth", "click_through"},
        {"stealth", "invisivel_gravacao"}, {"stealth", "screen_capture"},
        {"calendario", "url_ics"}, {"calendario", "token"},
    };
    const std::string s = ini::lower(section), k = ini::lower(key);
    for (const auto& e : known) {
        if (s == e.s && k == e.k) return true;
    }
    return false;
}

inline bool is_secret_setting(std::string_view section, std::string_view key) {
    const std::string s = ini::lower(section);
    const std::string k = ini::lower(key);
    if (s == "calendario" && k == "token") return true;
    return (s == "deepgram" || s == "llm") &&
           (k == "api_key" || k == "cerebras_api_key" || k == "groq_api_key");
}

inline std::string default_config_text() {
    return R"(; ============================================================================
; RealTimeAI settings
; ============================================================================
; Edit and save; changes apply the next time the app opens
; (Ctrl+Alt+Q closes it, then open it again). Ctrl+Alt+O opens this file.
; Key names are kept as they are for compatibility (sim = yes, nao = no).
;
; API keys: paste the key as plain text after "=". On the next run the app
; replaces it with "dpapi:...", an encrypted version only your Windows user
; can read. To change a key, delete the "dpapi:..." value and paste the new one.
;
; An empty field falls back to the matching environment variable
; (e.g. DEEPGRAM_API_KEY) and then to the default.

[deepgram]
; Deepgram key (required for live mode): https://console.deepgram.com
api_key =
; multi = Portuguese + English in the same conversation. Others: pt-BR, en, es...
idioma = multi
; Names the STT must get right (product, company, people), comma-separated
termos =
; With idioma = multi: the most likely languages of the call (only a hint)
dicas_idioma = pt, en
; Pause (ms) for Deepgram to close a phrase; 0 turns it off. 100 is recommended
; for idioma = multi (the old default 300 is treated as 100 in that case)
endpointing_ms = 100

[llm]
; OpenRouter key (https://openrouter.ai/keys). Empty = transcription only.
api_key =
; Direct Cerebras key (https://cloud.cerebras.ai). Takes priority when set.
cerebras_api_key =
; Any OpenAI-compatible endpoint (OpenRouter, OpenAI, Ollama, LM Studio)
url = https://openrouter.ai/api/v1/chat/completions
modelo = qwen-3.8-27b
; minimal, low, medium, high or off
raciocinio = minimal
max_tokens = 900
temperatura = 0.3
; sim = suggests on its own when [Outros] (the other side) asks a question
; nao = only with Ctrl+Alt+Enter
sugestao_automatica = sim
; Trigger words (comma-separated). Empty = built-in sales list (off when an interview goal is loaded)
palavras_chave =
; Minimum time between automatic suggestions (seconds)
intervalo_minimo_s = 4
; .md/.txt file with your notes (product, pricing, objections, agenda)
arquivo_contexto =

[audio]
microfone = sim
audio_sistema = sim
; silero (recommended) or energia (energy)
vad = silero
; Empty = silero_vad.onnx next to the program
silero_modelo =
; Only for vad = energia: sensitivity (lower = more sensitive)
limiar_energia = 0.01

[rag]
; Hybrid retrieval: BM25 (exact names, acronyms, numbers) + local embeddings
; (paraphrases, PT<->EN). Needs the model: scripts\windows\download-embeddings-model.bat
hibrido = sim
; Empty = %LOCALAPPDATA%\RealTimeAI\models\multilingual-e5-small
modelo_embeddings =
; Longest a question waits for its embedding, in ms (0 = only reuse ready ones)
orcamento_ms = 12
; Minimum similarity (0-1) for an excerpt found only by meaning
similaridade_minima = 0.80
; CPU threads for the embedding model
threads = 2

[overlay]
; Initial width in pixels (420 to 1100). After that, the width you drag on the HUD edge wins.
largura = 860
; Maximum height, in % of the screen height
altura_max_pct = 60

[sessao]
salvar = sim
; Empty = %LOCALAPPDATA%\RealTimeAI\sessions
pasta =
)";
}

// ---------------------------------------------------------------------------
// Base64 (for the DPAPI blobs).
// ---------------------------------------------------------------------------
inline std::string base64_encode(std::string_view in) {
    static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((in.size() + 2) / 3 * 4);
    std::size_t i = 0;
    while (i + 2 < in.size()) {
        const unsigned v = (static_cast<unsigned char>(in[i]) << 16) |
                           (static_cast<unsigned char>(in[i + 1]) << 8) |
                           static_cast<unsigned char>(in[i + 2]);
        out += t[(v >> 18) & 63];
        out += t[(v >> 12) & 63];
        out += t[(v >> 6) & 63];
        out += t[v & 63];
        i += 3;
    }
    if (i < in.size()) {
        unsigned v = static_cast<unsigned char>(in[i]) << 16;
        if (i + 1 < in.size()) v |= static_cast<unsigned char>(in[i + 1]) << 8;
        out += t[(v >> 18) & 63];
        out += t[(v >> 12) & 63];
        out += i + 1 < in.size() ? t[(v >> 6) & 63] : '=';
        out += '=';
    }
    return out;
}

inline std::optional<std::string> base64_decode(std::string_view in) {
    auto val = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };
    if (in.size() % 4 != 0) return std::nullopt;
    std::string out;
    for (std::size_t i = 0; i < in.size(); i += 4) {
        int v[4];
        int pad = 0;
        for (int k = 0; k < 4; ++k) {
            const char c = in[i + static_cast<std::size_t>(k)];
            if (c == '=' && i + 4 == in.size() && k >= 2) {
                v[k] = 0;
                ++pad;
            } else {
                v[k] = val(c);
                if (v[k] < 0 || pad) return std::nullopt;
            }
        }
        const unsigned n = (static_cast<unsigned>(v[0]) << 18) | (static_cast<unsigned>(v[1]) << 12) |
                           (static_cast<unsigned>(v[2]) << 6) | static_cast<unsigned>(v[3]);
        out += static_cast<char>((n >> 16) & 0xFF);
        if (pad < 2) out += static_cast<char>((n >> 8) & 0xFF);
        if (pad < 1) out += static_cast<char>(n & 0xFF);
    }
    return out;
}

} // namespace rtai
