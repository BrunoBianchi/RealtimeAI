// config.ini parsing, precedence (file > env > default), secret handling and
// in-place rewriting that keeps comments.
#include <gtest/gtest.h>

#include <map>
#include <string>

#include "rtai/ini.hpp"
#include "rtai/settings.hpp"

using namespace rtai;

namespace {
EnvLookup env_from(std::map<std::string, std::string> m) {
    return [m](const char* name) {
        auto it = m.find(name);
        return it == m.end() ? std::string() : it->second;
    };
}
SecretDecoder fake_decoder() {
    return [](const std::string& v) -> std::optional<std::string> {
        if (v == "dpapi:BOM") return std::string("chave-decifrada");
        return std::nullopt;
    };
}
} // namespace

TEST(Ini, ParsesSectionsCommentsQuotesAndCase) {
    const auto f = ini::File::parse(
        "\xEF\xBB\xBF; comentario\r\n"
        "[Deepgram]\r\n"
        "API_KEY = abc123   ; inline\r\n"
        "idioma=\"pt-BR\"\r\n"
        "termos = RealTime AI, Nova-3\r\n"
        "[llm]\r\n"
        "modelo = openai/gpt#4\r\n");
    EXPECT_EQ(f.get("deepgram", "api_key").value(), "abc123");
    EXPECT_EQ(f.get("DEEPGRAM", "idioma").value(), "pt-BR");
    EXPECT_EQ(f.get("deepgram", "termos").value(), "RealTime AI, Nova-3");
    EXPECT_EQ(f.get("llm", "modelo").value(), "openai/gpt#4"); // '#' without space is data
    EXPECT_FALSE(f.get("llm", "inexistente").has_value());
}

TEST(Ini, RewriteValueKeepsEverythingElse) {
    const std::string text =
        "; topo\r\n[deepgram]\r\n; a chave\r\napi_key = minha-chave ; nota\r\nidioma = multi\r\n";
    auto out = ini::rewrite_value(text, "deepgram", "api_key",
                                  [](const std::string& old) -> std::optional<std::string> {
                                      return "dpapi:" + old;
                                  });
    ASSERT_TRUE(out.has_value());
    EXPECT_EQ(*out,
              "; topo\r\n[deepgram]\r\n; a chave\r\napi_key = dpapi:minha-chave ; nota\r\nidioma = multi\r\n");
    // Same key in another section is untouched; missing key -> nullopt.
    EXPECT_FALSE(ini::rewrite_value(text, "llm", "api_key",
                                    [](const std::string&) { return std::optional<std::string>("x"); })
                     .has_value());
}

TEST(Ini, RewriteEmptyValueAddsSpace) {
    auto out = ini::rewrite_value("[llm]\napi_key =\n", "llm", "api_key",
                                  [](const std::string&) { return std::optional<std::string>("dpapi:X"); });
    ASSERT_TRUE(out.has_value());
    EXPECT_EQ(*out, "[llm]\napi_key = dpapi:X\n");
}

TEST(Ini, ParsesBooleansInPortugueseAndEnglish) {
    EXPECT_EQ(ini::parse_bool("Sim"), true);
    EXPECT_EQ(ini::parse_bool("não"), false);
    EXPECT_EQ(ini::parse_bool("true"), true);
    EXPECT_EQ(ini::parse_bool("0"), false);
    EXPECT_FALSE(ini::parse_bool("talvez").has_value());
}

TEST(Settings, TemplateLoadsWithDefaultsAndNoWarnings) {
    const auto s = load_settings(ini::File::parse(default_config_text()), env_from({}), fake_decoder());
    EXPECT_TRUE(s.warnings.empty());
    EXPECT_TRUE(s.deepgram_key.empty());
    EXPECT_EQ(s.language, "multi");
    EXPECT_EQ(s.model, "qwen-3.8-27b");
    EXPECT_EQ(s.reasoning, "minimal");
    EXPECT_EQ(s.endpointing_ms, 100); // recommended by Deepgram for language=multi
    EXPECT_EQ(s.language_hints, (std::vector<std::string>{"pt", "en"}));
    EXPECT_TRUE(s.auto_suggest);
    EXPECT_EQ(s.vad, "silero");
    EXPECT_TRUE(s.save_sessions);
    EXPECT_EQ(default_config_text().find("\xE2\x80\x94"), std::string::npos); // no em dashes
}

TEST(Settings, ConfigWinsOverEnvAndEnvOverDefault) {
    const auto f = ini::File::parse("[deepgram]\napi_key = da-config\nidioma =\n[llm]\nmodelo =\n");
    const auto s = load_settings(f,
                                 env_from({{"DEEPGRAM_API_KEY", "do-env"},
                                           {"RTAI_DG_LANGUAGE", "pt-BR"},
                                           {"OPENROUTER_API_KEY", "or-env"}}),
                                 fake_decoder());
    EXPECT_EQ(s.deepgram_key, "da-config");
    EXPECT_EQ(s.deepgram_key_source, "config.ini");
    EXPECT_EQ(s.language, "pt-BR"); // empty in file -> env
    EXPECT_EQ(s.llm_key, "or-env");
    EXPECT_EQ(s.llm_key_source, "environment variable");
    EXPECT_EQ(s.model, "qwen-3.8-27b"); // empty everywhere -> default
}

TEST(Settings, DecryptsProtectedKeysAndWarnsWhenItCannot) {
    const auto ok = load_settings(ini::File::parse("[llm]\napi_key = dpapi:BOM\n"), env_from({}), fake_decoder());
    EXPECT_EQ(ok.llm_key, "chave-decifrada");
    EXPECT_TRUE(ok.warnings.empty());

    const auto bad = load_settings(ini::File::parse("[llm]\napi_key = dpapi:OUTRO-PC\n"),
                                   env_from({{"OPENROUTER_API_KEY", "fallback"}}), fake_decoder());
    ASSERT_EQ(bad.warnings.size(), 1u);
    EXPECT_NE(bad.warnings[0].find("could not be decrypted"), std::string::npos);
    EXPECT_EQ(bad.llm_key, "fallback");
}

TEST(Settings, ParsesTypesClampsAndReportsBadValues) {
    const auto s = load_settings(ini::File::parse(
                                     "[llm]\nraciocinio = off\ntemperatura = 0,7\nmax_tokens = 999999\n"
                                     "sugestao_automatica = nao\npalavras_chave = preço, prazo\n"
                                     "[audio]\nvad = Energia\nmicrofone = talvez\n[overlay]\nlargura = abc\n"),
                                 env_from({}), fake_decoder());
    EXPECT_TRUE(s.reasoning.empty());
    EXPECT_DOUBLE_EQ(s.temperature, 0.7);
    EXPECT_EQ(s.max_tokens, 4000);
    EXPECT_FALSE(s.auto_suggest);
    EXPECT_EQ(s.keywords, (std::vector<std::string>{"preço", "prazo"}));
    EXPECT_EQ(s.vad, "energia");
    EXPECT_TRUE(s.mic_enabled);        // invalid -> keeps default
    EXPECT_EQ(s.overlay_width, 860);   // invalid -> keeps default
    EXPECT_EQ(s.warnings.size(), 2u);
}

TEST(Settings, ModelTierNormalizationRespectsKeys) {
    // OpenRouter key present: short "llama-3.3-70b" maps to full "meta-llama/llama-3.3-70b-instruct"
    const auto s1 = load_settings(ini::File::parse("[llm]\napi_key = dpapi:BOM\nmodelo = llama-3.3-70b\n"),
                                  env_from({}), fake_decoder());
    EXPECT_EQ(s1.model, "meta-llama/llama-3.3-70b-instruct");

    // Only Cerebras key present: "llama-3.3-70b" maps to Cerebras "qwen-3.8-27b"
    const auto s2 = load_settings(ini::File::parse("[llm]\ncerebras_api_key = csk-key\nmodelo = llama-3.3-70b\n"),
                                  env_from({}), fake_decoder());
    EXPECT_EQ(s2.model, "qwen-3.8-27b");

    // OpenRouter key without Cerebras: "gpt-oss-120b" maps to "qwen/qwen-2.5-72b-instruct"
    const auto s3 = load_settings(ini::File::parse("[llm]\napi_key = dpapi:BOM\nmodelo = gpt-oss-120b\n"),
                                  env_from({}), fake_decoder());
    EXPECT_EQ(s3.model, "qwen/qwen-2.5-72b-instruct");
}

TEST(Settings, ParsesStealthAndPrivacyOptions) {
    // Defaults: dock=true, activity_monitor=true, click_through=false, screen_capture=true
    const auto def = load_settings(ini::File::parse(default_config_text()), env_from({}), fake_decoder());
    EXPECT_TRUE(def.stealth_dock);
    EXPECT_TRUE(def.stealth_activity_monitor);
    EXPECT_FALSE(def.stealth_click_through);
    EXPECT_TRUE(def.stealth_screen_capture);

    // Explicit overrides
    const auto custom = load_settings(ini::File::parse("[stealth]\n"
                                                       "invisivel_barra_tarefas = nao\n"
                                                       "invisivel_gerenciador = nao\n"
                                                       "clique_atravessa = sim\n"
                                                       "invisivel_gravacao = nao\n"),
                                      env_from({}), fake_decoder());
    EXPECT_FALSE(custom.stealth_dock);
    EXPECT_FALSE(custom.stealth_activity_monitor);
    EXPECT_TRUE(custom.stealth_click_through);
    EXPECT_FALSE(custom.stealth_screen_capture);

    // English aliases
    const auto en = load_settings(ini::File::parse("[stealth]\n"
                                                   "dock = false\n"
                                                   "activity_monitor = false\n"
                                                   "click_through = true\n"
                                                   "screen_capture = false\n"),
                                  env_from({}), fake_decoder());
    EXPECT_FALSE(en.stealth_dock);
    EXPECT_FALSE(en.stealth_activity_monitor);
    EXPECT_TRUE(en.stealth_click_through);
    EXPECT_FALSE(en.stealth_screen_capture);
}

TEST(Settings, Base64RoundTrip) {
    for (std::string v : {std::string(""), std::string("a"), std::string("ab"), std::string("abc"),
                          std::string("\x00\xFF\x10" "binary", 9)}) {
        auto back = base64_decode(base64_encode(v));
        ASSERT_TRUE(back.has_value());
        EXPECT_EQ(*back, v);
    }
    EXPECT_FALSE(base64_decode("abc").has_value());
    EXPECT_FALSE(base64_decode("a=bc").has_value());
}
