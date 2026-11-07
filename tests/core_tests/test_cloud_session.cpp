// lipcue.com cloud backend, client side: backend choice, the /v1/session
// request/response contract and how it maps onto the Deepgram stream.
#include <gtest/gtest.h>

#include <map>
#include <string>

#include "rtai/cloud_session.hpp"
#include "rtai/deepgram_protocol.hpp"
#include "rtai/ini.hpp"
#include "rtai/settings.hpp"

using namespace rtai;

namespace {

Settings settings_from(const std::string& ini_text) {
    const EnvLookup no_env = [](const char*) { return std::string(); };
    const SecretDecoder plain = [](const std::string& v) -> std::optional<std::string> { return v; };
    return load_settings(ini::File::parse(ini_text), no_env, plain);
}

const char* kGoodSession = R"({
  "session_id": "sess_123",
  "expires_at": 1900000600,
  "refresh_after_s": 300,
  "stt": {"url": "wss://api.deepgram.com/v1/listen", "token": "dg-temp", "model": "nova-3",
          "extra_query": "tag=sess_123"},
  "llm": {"url": "https://edge.example.com/v1/chat/completions", "token": "llm-temp",
          "model": "qwen/qwen3.6-flash", "background_model": "qwen/qwen3.6-flash",
          "fallback": {"url": "https://edge2.example.com/v1/chat/completions", "token": "fb"}},
  "account": {"plan": "pro", "minutes_left": 512},
  "notice": "Bem-vindo"
})";

} // namespace

TEST(CloudSettings, ReadsServidorSectionAndTreatsTokenAsSecret) {
    const Settings s = settings_from("[servidor]\nmodo = nuvem\nurl = https://api.example.com/\n"
                                     "token = devtok\nregiao = sa-east-1\n");
    EXPECT_EQ(s.server_mode, "nuvem");
    EXPECT_EQ(s.server_url, "https://api.example.com/");
    EXPECT_EQ(s.server_token, "devtok");
    EXPECT_EQ(s.server_region, "sa-east-1");
    EXPECT_TRUE(is_known_setting("servidor", "token"));
    EXPECT_TRUE(is_secret_setting("servidor", "token"));
    EXPECT_FALSE(is_secret_setting("servidor", "url"));
    EXPECT_EQ(cloud::effective_base_url(s), "https://api.example.com");
}

TEST(CloudSettings, InvalidModeWarnsAndKeepsAuto) {
    const Settings s = settings_from("[servidor]\nmodo = talvez\n");
    EXPECT_EQ(s.server_mode, "auto");
    EXPECT_FALSE(s.warnings.empty());
}

TEST(CloudBackend, SignInIsRequiredAndProprioOnlyChangesWhereAudioGoes) {
    Settings s;
    s.server_url = "https://api.example.com";
    EXPECT_FALSE(cloud::signed_in(s));
    s.server_token = "tok";
    EXPECT_TRUE(cloud::signed_in(s));
    EXPECT_EQ(cloud::choose_backend(s), cloud::Backend::Cloud);
    s.server_mode = "proprio";
    EXPECT_EQ(cloud::choose_backend(s), cloud::Backend::Own);
    EXPECT_TRUE(cloud::signed_in(s)); // own keys still need the account (quota)
    s.server_url = "nao-e-url";
    if (std::string(cloud::kDefaultServerUrl).empty()) {
        EXPECT_FALSE(cloud::signed_in(s)); // no usable server
    }
}

TEST(CloudBackend, LocalModeNeedsNoAccountOrServer) {
    Settings s;
    s.server_mode = "local";
    EXPECT_EQ(cloud::choose_backend(s), cloud::Backend::Local);
    EXPECT_TRUE(cloud::local_mode(s));
    EXPECT_STREQ(cloud::to_string(cloud::Backend::Local), "local");
    s.server_mode = "Offline";
    EXPECT_TRUE(cloud::local_mode(s));
    s.server_mode = "proprio";
    EXPECT_FALSE(cloud::local_mode(s));
    s.server_mode = "auto";
    EXPECT_FALSE(cloud::local_mode(s));
    EXPECT_GT(cloud::kLocalAnswerDelayMs, 0);
    EXPECT_LE(cloud::kLocalAnswerDelayMs, 1000); // "a little" slower, not unusable
}

TEST(CloudPlan, FreeIsOneSessionOf15MinutesProIs200PerMonth) {
    EXPECT_EQ(cloud::plan_rules("free").minutes, 15);
    EXPECT_FALSE(cloud::plan_rules("free").monthly);
    EXPECT_EQ(cloud::plan_rules("free").max_sessions, 1);
    EXPECT_EQ(cloud::plan_rules("PRO").minutes, 200);
    EXPECT_TRUE(cloud::plan_rules("pro").monthly);
    EXPECT_EQ(cloud::plan_rules("desconhecido").id, std::string("free")); // never unbounded
}

TEST(CloudPlan, SessionBudgetUsesServerValuesCappedByMinutesLeft) {
    cloud::Session s;
    s.plan = "free";
    EXPECT_EQ(cloud::session_budget_s(s), 15 * 60);        // plan default
    s.minutes_left = 10;
    EXPECT_EQ(cloud::session_budget_s(s), 10 * 60);        // what is left wins
    s.plan = "pro";
    s.minutes_left = 200;
    EXPECT_EQ(cloud::session_budget_s(s), 200 * 60);
    s.max_session_s = 3600;
    EXPECT_EQ(cloud::session_budget_s(s), 3600);           // server cap
    s.minutes_left = 5;
    EXPECT_EQ(cloud::session_budget_s(s), 300);
    EXPECT_EQ(cloud::budget_warning_s(900), 840);          // one minute before
    EXPECT_EQ(cloud::budget_warning_s(60), 30);
}

TEST(CloudPlan, NoMinutesLeftRefusesTheSessionAndOwnKeysNeedNoCredentials) {
    std::string err;
    EXPECT_FALSE(cloud::parse_session(R"({"session_id":"s","account":{"plan":"free","minutes_left":0}})", err, false));
    EXPECT_NE(err.find("minutes"), std::string::npos);
    auto s = cloud::parse_session(R"({"session_id":"s","account":{"plan":"pro","minutes_left":120,"max_session_s":7200}})",
                                  err, /*require_credentials=*/false);
    ASSERT_TRUE(s) << err;
    EXPECT_FALSE(s->has_credentials());
    EXPECT_EQ(s->max_session_s, 7200);
    EXPECT_FALSE(cloud::parse_session(R"({"session_id":"s"})", err, /*require_credentials=*/true));
}

TEST(CloudSession, RequestBodyCarriesVersionLanguageAndCapabilities) {
    cloud::SessionRequest r;
    r.app_version = "2.1.0";
    r.language = "multi";
    r.model = "qwen/qwen3.6-flash";
    r.region = "auto"; // "auto" is not sent: the server decides
    const auto body = json::Parser::parse(cloud::build_session_request(r));
    ASSERT_TRUE(body);
    EXPECT_EQ((*body)["api"].as_number(), 1.0);
    EXPECT_EQ((*body)["app_version"].as_string(), "2.1.0");
    EXPECT_EQ((*body)["language"].as_string(), "multi");
    EXPECT_FALSE(body->has("region"));
    EXPECT_TRUE((*body)["credentials"].as_bool());
    EXPECT_EQ((*body)["capabilities"]["stt"].at(0).as_string(), "deepgram-ws");
}

TEST(CloudSession, ParsesAFullResponse) {
    std::string err;
    const auto s = cloud::parse_session(kGoodSession, err);
    ASSERT_TRUE(s) << err;
    EXPECT_EQ(s->session_id, "sess_123");
    EXPECT_EQ(s->refresh_after_s, 300);
    EXPECT_EQ(s->stt.token, "dg-temp");
    EXPECT_EQ(s->stt_extra_query, "tag=sess_123");
    EXPECT_EQ(s->llm.model, "qwen/qwen3.6-flash");
    EXPECT_TRUE(s->llm_fallback.valid());
    EXPECT_EQ(s->plan, "pro");
    EXPECT_EQ(s->minutes_left, 512);
    EXPECT_EQ(s->notice, "Bem-vindo");
}

TEST(CloudSession, RejectsMissingOrNonWebSocketStt) {
    std::string err;
    EXPECT_FALSE(cloud::parse_session(R"({"stt":{"url":"https://x/v1/listen","token":"t"}})", err));
    EXPECT_FALSE(err.empty());
    EXPECT_FALSE(cloud::parse_session(R"({"llm":{"url":"https://x","token":"t"}})", err));
    EXPECT_FALSE(cloud::parse_session("not json", err));
}

TEST(CloudSession, ServerErrorMessageIsSurfaced) {
    std::string err;
    EXPECT_FALSE(cloud::parse_session(R"({"error":{"message":"Plano sem minutos"}})", err));
    EXPECT_EQ(err, "Plano sem minutos");
}

TEST(CloudSession, LlmIsOptionalButABrokenFallbackIsDropped) {
    std::string err;
    auto s = cloud::parse_session(R"({"stt":{"url":"wss://h/v1/listen","token":"t"}})", err);
    ASSERT_TRUE(s) << err;
    EXPECT_FALSE(s->llm.valid()); // transcription-only plan

    s = cloud::parse_session(R"({"stt":{"url":"wss://h/v1/listen","token":"t"},
        "llm":{"url":"https://l/v1/chat/completions","token":"k",
               "fallback":{"url":"http://insecure/v1","token":"f"}}})", err);
    ASSERT_TRUE(s) << err;
    EXPECT_TRUE(s->llm.valid());
    EXPECT_FALSE(s->llm_fallback.valid());
}

// The exact shape backend/internal/server/session.go sends (docs/server-api.md).
TEST(CloudSession, ReadsTheFallbackTheServerSends) {
    std::string err;
    auto s = cloud::parse_session(R"({"session_id":"sess_1","stt":{"url":"wss://api.deepgram.com/v1/listen","token":"t"},
        "llm":{"url":"https://api.example.com/v1/llm/chat/completions","token":"llm_a","model":"main","background_model":"main",
               "fallback":{"url":"https://api.example.com/v1/llm/chat/completions","token":"llm_a","model":"alt"}}})", err);
    ASSERT_TRUE(s) << err;
    ASSERT_TRUE(s->llm_fallback.valid());
    EXPECT_EQ(s->llm_fallback.url, "https://api.example.com/v1/llm/chat/completions");
    EXPECT_EQ(s->llm_fallback.token, "llm_a");
    EXPECT_EQ(s->llm_fallback.model, "alt");
    EXPECT_EQ(s->llm.model, "main");
}

TEST(CloudSession, AnHttpFallbackFromTheServerDoesNotFailTheSession) {
    std::string err;
    auto s = cloud::parse_session(R"({"session_id":"sess_1","stt":{"url":"wss://api.deepgram.com/v1/listen","token":"t"},
        "llm":{"url":"http://203.0.113.5/v1/llm/chat/completions","token":"llm_a","model":"main",
               "fallback":{"url":"http://203.0.113.5/v1/llm/chat/completions","token":"llm_a","model":"alt"}}})", err);
    ASSERT_TRUE(s) << err;
    EXPECT_TRUE(s->llm.valid());
    EXPECT_FALSE(s->llm_fallback.valid());
}

TEST(CloudSession, SttTargetFeedsTheListenPath) {
    std::string err;
    auto s = cloud::parse_session(
        R"({"stt":{"url":"wss://stt.example.com:8443/relay/listen?ignored=1","token":"t"}})", err);
    ASSERT_TRUE(s) << err;
    s->stt_extra_query = "tag=abc";
    const auto t = cloud::stt_target(*s);
    ASSERT_TRUE(t);
    EXPECT_EQ(t->host, "stt.example.com");
    EXPECT_EQ(t->port, 8443);
    EXPECT_TRUE(t->secure);
    EXPECT_EQ(t->path, "/relay/listen");

    dg::StreamParams p;
    p.path = t->path;
    p.extra_query = s->stt_extra_query;
    const std::string q = dg::build_listen_path(p);
    EXPECT_EQ(q.rfind("/relay/listen?model=nova-3", 0), 0u) << q;
    EXPECT_NE(q.find("&tag=abc"), std::string::npos) << q;
}

TEST(CloudSession, RefreshHappensBeforeExpiryAndNeverTooOften) {
    cloud::Session s;
    s.refresh_after_s = 300;
    s.expires_at_s = 1000 + 120;                    // expires in 2 min
    EXPECT_EQ(cloud::refresh_delay_s(s, 1000), 90); // 30 s of margin
    s.expires_at_s = 1000 + 20;                     // nearly expired
    EXPECT_EQ(cloud::refresh_delay_s(s, 1000), 15);
    s.expires_at_s = 0;
    EXPECT_EQ(cloud::refresh_delay_s(s, 1000), 300);
}

TEST(CloudSession, SessionEndBody) {
    cloud::SessionEnd e;
    e.duration_s = 1800;
    e.stt_audio_s = 1500;
    e.answers = 12;
    const auto v = json::Parser::parse(cloud::build_session_end(e));
    ASSERT_TRUE(v);
    EXPECT_EQ((*v)["duration_s"].as_number(), 1800.0);
    EXPECT_FALSE(v->has("avg_ttft_ms"));
}
