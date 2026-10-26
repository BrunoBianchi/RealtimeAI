// --server wire protocol (headless engine <-> external client), line channel, config upsert.
#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rtai/ini.hpp"
#include "rtai/json_min.hpp"
#include "rtai/line_channel.hpp"
#include "rtai/server_protocol.hpp"
#include "rtai/settings.hpp"

using namespace rtai;
using namespace std::chrono_literals;

namespace {
json::Value parse(const std::string& s) {
    auto v = json::Parser::parse(s);
    EXPECT_TRUE(v.has_value()) << s;
    return v ? *v : json::Value();
}
} // namespace

TEST(ServerProtocol, EventsSerializeToOneLineJson) {
    SuggestionStartedEvent st;
    st.id = 7;
    st.trigger_text = "Your pricing is \"significantly\" higher\nthan the alternative.";
    st.trigger_source = AudioSource::Loopback;
    st.reason = TriggerReason::Question;
    st.model = "m";
    st.has_image = true;
    const std::string line = server::encode_event(st);
    EXPECT_EQ(line.find('\n'), std::string::npos);
    const auto v = parse(line);
    EXPECT_EQ(v["type"].as_string(), "answer_start");
    EXPECT_EQ(v["id"].as_number(), 7);
    EXPECT_EQ(v["trigger"].as_string(), st.trigger_text);
    EXPECT_EQ(v["src"].as_string(), "outros");
    EXPECT_EQ(v["reason"].as_string(), "question");
    EXPECT_TRUE(v["image"].as_bool());

    const auto d = parse(server::encode_event(SuggestionDeltaEvent{7, "olá "}));
    EXPECT_EQ(d["type"].as_string(), "answer_delta");
    EXPECT_EQ(d["text"].as_string(), "olá ");

    SuggestionDoneEvent done;
    done.id = 7;
    done.status = LlmStatus::Failed;
    done.error = "HTTP 401";
    const auto dn = parse(server::encode_event(done));
    EXPECT_EQ(dn["status"].as_string(), "failed");
    EXPECT_EQ(dn["error"].as_string(), "HTTP 401");

    TranscriptUpdateEvent live{AudioSource::Microphone, "estou falando", false, 1200};
    const auto lv = parse(server::encode_event(live));
    EXPECT_EQ(lv["type"].as_string(), "live");
    EXPECT_EQ(lv["src"].as_string(), "voce");
    EXPECT_FALSE(lv["closed"].as_bool());

    TransportStatus ts;
    ts.source = AudioSource::Loopback;
    ts.state = LinkState::Reconnecting;
    ts.detail = "queda";
    const auto sv = parse(server::encode_event(LaneStatusEvent{ts, 5}));
    EXPECT_EQ(sv["state"].as_string(), "reconnecting");

    const auto pv = parse(server::encode_event(PauseEvent{true, -1, 3}));
    EXPECT_EQ(pv["src"].as_string(), "all");
    EXPECT_TRUE(server::encode_event(FeedbackEvent{1, 1, 0}).empty());
}

TEST(ServerProtocol, HelloLevelsAndBye) {
    server::Hello h;
    h.mode = true;
    h.ready = false;
    h.needs = "deepgram_key";
    h.config_path = "C:\\Users\\bruno\\AppData\\Local\\RealTimeAI\\config.ini";
    h.app_version = "2.1.0-beta.3";
    const auto v = parse(server::encode_hello(h));
    EXPECT_EQ(v["type"].as_string(), "hello");
    EXPECT_EQ(v["version"].as_number(), server::kProtocolVersion);
    EXPECT_TRUE(v["mode"].as_bool());
    EXPECT_FALSE(v["ready"].as_bool());
    EXPECT_EQ(v["config_path"].as_string(), h.config_path);
    EXPECT_EQ(v["app_version"].as_string(), "2.1.0-beta.3");

    server::Levels l;
    l.voce = 0.456f;
    l.outros_speaking = true;
    const auto lv = parse(server::encode_levels(l));
    EXPECT_NEAR(lv["voce"].as_number(), 0.46, 0.001);
    EXPECT_TRUE(lv["outros_speaking"].as_bool());

    const auto b = parse(server::encode_bye("a.jsonl", "a.md"));
    EXPECT_EQ(b["summary"].as_string(), "a.md");
}

TEST(ServerProtocol, ParsesCommands) {
    using K = server::Command::Kind;
    EXPECT_EQ(server::parse_command(R"({"cmd":"answer"})")->kind, K::Answer);
    auto chat = server::parse_command(R"({"cmd":"chat","text":"  quanto custa?  "})");
    ASSERT_TRUE(chat);
    EXPECT_EQ(chat->text, "quanto custa?");
    auto shot = server::parse_command(R"({"cmd":"screenshot","image":"data:image/jpeg;base64,QUJD","text":""})");
    ASSERT_TRUE(shot);
    EXPECT_EQ(shot->kind, K::Screenshot);
    auto pause = server::parse_command(R"({"cmd":"pause","src":"voce","paused":true})");
    ASSERT_TRUE(pause);
    EXPECT_EQ(pause->source, static_cast<int>(AudioSource::Microphone));
    EXPECT_TRUE(pause->paused);
    EXPECT_EQ(server::parse_command(R"({"cmd":"pause","paused":false})")->source, -1);
    auto rate = server::parse_command(R"({"cmd":"rate","id":4,"vote":-1})");
    ASSERT_TRUE(rate);
    EXPECT_EQ(rate->id, 4u);
    EXPECT_EQ(rate->vote, -1);
    auto cfg = server::parse_command(
        R"({"cmd":"set_config","values":[{"section":"deepgram","key":"api_key","value":" abc "}]})");
    ASSERT_TRUE(cfg);
    ASSERT_EQ(cfg->values.size(), 1u);
    EXPECT_EQ(cfg->values[0].value, "abc");
    EXPECT_EQ(server::parse_command(R"({"cmd":"quit"})")->kind, K::Quit);
}

TEST(ServerProtocol, RejectsBadCommands) {
    std::string err;
    EXPECT_FALSE(server::parse_command("not json", &err));
    EXPECT_FALSE(server::parse_command(R"({"cmd":"chat","text":"   "})", &err));
    EXPECT_FALSE(server::parse_command(R"({"cmd":"screenshot","image":"file:///c:/x.png"})", &err));
    EXPECT_FALSE(server::parse_command(R"({"cmd":"screenshot","image":"https://x/y.png"})", &err));
    EXPECT_FALSE(server::parse_command(R"({"cmd":"pause","src":"x","paused":true})", &err));
    EXPECT_FALSE(server::parse_command(R"({"cmd":"rate","vote":1})", &err));
    EXPECT_FALSE(server::parse_command(
        R"({"cmd":"set_config","values":[{"section":"llm","key":"modelo","value":"a\nb = c"}]})", &err));
    EXPECT_FALSE(server::parse_command(R"({"cmd":"rm -rf"})", &err));
    EXPECT_EQ(err, "comando desconhecido");
}

TEST(ServerProtocol, LineSplitterHandlesChunksCrlfAndOversize) {
    server::LineSplitter sp(32);
    std::vector<std::string> got;
    auto on = [&](std::string_view l) { got.emplace_back(l); };
    sp.feed("{\"cmd\":", on);
    sp.feed("\"answer\"}\r\n\n{\"a\":1}\n", on);
    sp.feed(std::string(40, 'x'), on); // oversize: dropped
    sp.feed("yy\nok\n", on);
    ASSERT_EQ(got.size(), 3u);
    EXPECT_EQ(got[0], "{\"cmd\":\"answer\"}");
    EXPECT_EQ(got[1], "{\"a\":1}");
    EXPECT_EQ(got[2], "ok");
}

TEST(LineChannel, KeepsOrderAndAddsNewlines) {
    std::mutex mu;
    std::string out;
    {
        LineChannel ch([&](std::string_view s) {
            std::lock_guard<std::mutex> lk(mu);
            out.append(s);
            return true;
        });
        std::vector<std::thread> ts;
        for (int t = 0; t < 4; ++t) {
            ts.emplace_back([&ch, t] {
                for (int i = 0; i < 200; ++i) ch.send("t" + std::to_string(t) + ":" + std::to_string(i));
            });
        }
        for (auto& t : ts) t.join();
        ch.stop();
    }
    // Every line intact, and per-thread order preserved.
    int last[4] = {-1, -1, -1, -1};
    std::size_t lines = 0, pos = 0;
    while (pos < out.size()) {
        const auto nl = out.find('\n', pos);
        ASSERT_NE(nl, std::string::npos);
        const std::string l = out.substr(pos, nl - pos);
        const int t = l[1] - '0';
        const int i = std::stoi(l.substr(3));
        EXPECT_EQ(i, last[t] + 1);
        last[t] = i;
        ++lines;
        pos = nl + 1;
    }
    EXPECT_EQ(lines, 800u);
}

TEST(LineChannel, StuckReaderDropsLevelsFirstAndBrokenPipeStops) {
    std::atomic<bool> release{false};
    std::vector<std::string> got;
    std::mutex mu;
    LineChannel ch(
        [&](std::string_view s) {
            while (!release.load()) std::this_thread::sleep_for(1ms);
            std::lock_guard<std::mutex> lk(mu);
            got.emplace_back(s);
            return true;
        },
        3);
    ch.send("first");                 // taken by the writer, which blocks
    std::this_thread::sleep_for(20ms);
    ch.send("lvl1", true);
    ch.send("a");
    ch.send("b");
    ch.send("c");                     // queue full (3): drops lvl1, not a/b
    ch.send("lvl2", true);            // full again: droppable is refused
    release = true;
    ch.stop();
    std::vector<std::string> expect{"first\n", "a\n", "b\n", "c\n"};
    EXPECT_EQ(got, expect);
    EXPECT_EQ(ch.dropped(), 2u);

    LineChannel broken([](std::string_view) { return false; });
    broken.send("x");
    for (int i = 0; i < 100 && !broken.broken(); ++i) std::this_thread::sleep_for(1ms);
    EXPECT_TRUE(broken.broken());
    broken.send("y"); // ignored, no crash
}

TEST(ConfigUpsert, UpdatesInsertsAndAppendsKeepingStyle) {
    const std::string base = "\xEF\xBB\xBF; topo\r\n[deepgram]\r\napi_key =\r\nidioma = multi\r\n\r\n[llm]\r\nmodelo = x ; comentario\r\n";
    std::string t = ini::upsert_value(base, "deepgram", "api_key", "dpapi:AAA");
    EXPECT_NE(t.find("api_key = dpapi:AAA\r\n"), std::string::npos);
    t = ini::upsert_value(t, "llm", "modelo", "google/gemini");
    EXPECT_NE(t.find("modelo = google/gemini ; comentario\r\n"), std::string::npos);
    t = ini::upsert_value(t, "llm", "palavras_chave", *ini::encode_value("preço; prazo"));
    t = ini::upsert_value(t, "sessao", "salvar", "nao");
    const auto f = ini::File::parse(t);
    EXPECT_EQ(f.get("deepgram", "api_key").value(), "dpapi:AAA");
    EXPECT_EQ(f.get("deepgram", "idioma").value(), "multi");
    EXPECT_EQ(f.get("llm", "modelo").value(), "google/gemini");
    EXPECT_EQ(f.get("llm", "palavras_chave").value(), "preço; prazo");
    EXPECT_EQ(f.get("sessao", "salvar").value(), "nao");
    EXPECT_EQ(t.find("\n\n"), std::string::npos) << "only CRLF line endings";
    EXPECT_EQ(t.rfind("\xEF\xBB\xBF", 0), 0u) << "BOM kept";

    EXPECT_FALSE(ini::encode_value("a\"; b").has_value());
    EXPECT_FALSE(ini::encode_value("a\nb").has_value());
    EXPECT_EQ(ini::encode_value("pt-BR").value(), "pt-BR");
}

TEST(ConfigUpsert, WhitelistAndSecrets) {
    EXPECT_TRUE(is_known_setting("LLM", "Modelo"));
    EXPECT_TRUE(is_known_setting("deepgram", "api_key"));
    EXPECT_FALSE(is_known_setting("llm", "comando"));
    EXPECT_FALSE(is_known_setting("sistema", "api_key"));
    EXPECT_TRUE(is_secret_setting("llm", "api_key"));
    EXPECT_FALSE(is_secret_setting("llm", "modelo"));
}

TEST(ServerProtocol, TranscriptionModeProtocol) {
    using K = server::Command::Kind;
    auto cmd_on = server::parse_command(R"({"cmd":"set_mode","on":true})");
    ASSERT_TRUE(cmd_on);
    EXPECT_EQ(cmd_on->kind, K::SetMode);
    EXPECT_TRUE(cmd_on->mode_on);

    auto cmd_off = server::parse_command(R"({"cmd":"set_mode","on":false})");
    ASSERT_TRUE(cmd_off);
    EXPECT_EQ(cmd_off->kind, K::SetMode);
    EXPECT_FALSE(cmd_off->mode_on);

    const auto ev_on = parse(server::encode_event(TranscriptionModeEvent{true, 42}));
    EXPECT_EQ(ev_on["type"].as_string(), "mode");
    EXPECT_TRUE(ev_on["on"].as_bool());

    const auto ev_off = parse(server::encode_event(TranscriptionModeEvent{false, 42}));
    EXPECT_EQ(ev_off["type"].as_string(), "mode");
    EXPECT_FALSE(ev_off["on"].as_bool());

    server::Hello h_off;
    h_off.mode = false;
    const auto v_off = parse(server::encode_hello(h_off));
    EXPECT_FALSE(v_off["mode"].as_bool());

    server::Hello h_on;
    h_on.mode = true;
    const auto v_on = parse(server::encode_hello(h_on));
    EXPECT_TRUE(v_on["mode"].as_bool());

    const auto sum = parse(server::encode_summary(true, "Texto do resumo", "export.txt"));
    EXPECT_EQ(sum["type"].as_string(), "summary");
    EXPECT_TRUE(sum["ok"].as_bool());
    EXPECT_EQ(sum["text"].as_string(), "Texto do resumo");
    EXPECT_EQ(sum["export"].as_string(), "export.txt");
}
