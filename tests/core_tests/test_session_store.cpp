#include <gtest/gtest.h>

#include <atomic>
#include <filesystem>
#include <fstream>
#include <random>
#include <thread>
#include <vector>

#include "rtai/session_store.hpp"

using namespace rtai;
namespace fs = std::filesystem;

namespace {

fs::path fresh_dir(const char* name) {
    std::random_device rd;
    fs::path d = fs::temp_directory_path() / (std::string("rtai_sess_") + name + "_" + std::to_string(rd()));
    fs::remove_all(d);
    return d;
}

SessionMeta meta(const std::string& id) {
    SessionMeta m;
    m.id = id;
    m.started_at = "2026-10-20T21:50:03-03:00";
    m.mode = "live";
    m.stt_model = "nova-3";
    m.language = "multi";
    m.llm_model = "google/gemini-3.1-flash-lite";
    return m;
}

Turn turn(AudioSource s, std::string text, std::int64_t t0, std::int64_t t1, std::uint64_t seq) {
    return Turn{s, std::move(text), t0, t1, seq};
}

} // namespace

TEST(SessionStore, WritesJsonlAndMarkdownOnClose) {
    const fs::path dir = fresh_dir("basic");
    SessionStoreConfig cfg;
    cfg.dir = dir;
    SessionStore store{cfg};
    std::string err;
    ASSERT_TRUE(store.open(meta("s1"), &err)) << err;

    store.on_event(TurnEvent{turn(AudioSource::Loopback, "Qual é o prazo de \"entrega\"?", 1000, 2500, 1)});
    store.on_event(TranscriptUpdateEvent{AudioSource::Loopback, "interim nao persiste", false, 2600});
    store.on_event(SuggestionDeltaEvent{1, "delta nao persiste"});
    SuggestionDoneEvent done;
    done.id = 1;
    done.status = LlmStatus::Completed;
    done.text = "- Em **4 semanas**\nInsight: urgência";
    done.trigger_text = "Qual é o prazo de \"entrega\"?";
    done.reason = TriggerReason::Question;
    done.model = "google/gemini-3.1-flash-lite";
    done.ttft_ms = 820;
    done.total_ms = 2100;
    done.t_ms = 4600;
    store.on_event(done);
    TransportStatus st;
    st.source = AudioSource::Loopback;
    st.state = LinkState::Reconnecting;
    st.detail = "fechado pelo servidor (1011 NET-0001)";
    store.on_event(LaneStatusEvent{st, 5000});
    store.on_event(TurnEvent{turn(AudioSource::Microphone, "Em quatro semanas.", 6000, 7000, 2)});
    store.close("normal");
    store.close("again"); // idempotent

    std::size_t bad = 0;
    const auto records = SessionStore::load(store.jsonl_path(), &bad);
    EXPECT_EQ(bad, 0u);
    ASSERT_EQ(records.size(), 6u); // start, turn, suggestion, link, turn, end
    EXPECT_EQ(records.front()["type"].as_string(), "session_start");
    EXPECT_EQ(records[1]["text"].as_string(), "Qual é o prazo de \"entrega\"?");
    EXPECT_EQ(records[1]["src"].as_string(), "outros");
    EXPECT_EQ(records[2]["type"].as_string(), "suggestion");
    EXPECT_EQ(records[2]["reason"].as_string(), "question");
    EXPECT_EQ(records.back()["type"].as_string(), "session_end");
    EXPECT_EQ(records.back()["reason"].as_string(), "normal");

    std::string text;
    {
        // Scoped: Windows can't delete a file that is still open.
        std::ifstream md(store.markdown_path(), std::ios::binary);
        ASSERT_TRUE(md.good());
        text.assign((std::istreambuf_iterator<char>(md)), std::istreambuf_iterator<char>());
    }
    EXPECT_NE(text.find("# Session 2026-10-20 21:50"), std::string::npos);
    EXPECT_NE(text.find("**[00:01] Others:** Qual é o prazo"), std::string::npos);
    EXPECT_NE(text.find("**[00:06] You:** Em quatro semanas."), std::string::npos);
    EXPECT_NE(text.find("1st token in 0.8 s"), std::string::npos);
    EXPECT_NE(text.find("> Question: \"Qual é o prazo"), std::string::npos);
    EXPECT_NE(text.find("reconnecting"), std::string::npos);
    EXPECT_EQ(text.find("interim nao persiste"), std::string::npos);
    EXPECT_EQ(text.find("\xE2\x80\x94"), std::string::npos) << "no em dashes in the export";
    fs::remove_all(dir);
}

TEST(SessionStore, ConcurrentWritersLoseNothing) {
    const fs::path dir = fresh_dir("concurrent");
    SessionStoreConfig cfg;
    cfg.dir = dir;
    cfg.export_markdown = false;
    SessionStore store{cfg};
    ASSERT_TRUE(store.open(meta("s2")));
    constexpr int kThreads = 4, kPer = 500;
    std::vector<std::thread> ts;
    for (int t = 0; t < kThreads; ++t) {
        ts.emplace_back([&, t] {
            for (int i = 0; i < kPer; ++i) {
                store.on_event(NoticeEvent{NoticeLevel::Info, "t" + std::to_string(t) + "-" + std::to_string(i), i});
            }
        });
    }
    for (auto& t : ts) t.join();
    store.close();
    std::size_t bad = 0;
    const auto records = SessionStore::load(store.jsonl_path(), &bad);
    EXPECT_EQ(bad, 0u);
    EXPECT_EQ(records.size(), static_cast<std::size_t>(kThreads * kPer + 2));
    EXPECT_EQ(store.write_errors(), 0u);
    fs::remove_all(dir);
}

TEST(SessionStore, RecoversSessionWithTornLastLine) {
    const fs::path dir = fresh_dir("recover");
    fs::create_directories(dir);
    const fs::path file = dir / "crashed.jsonl";
    {
        std::ofstream f(file, std::ios::binary);
        f << R"({"type":"session_start","t":0,"id":"crashed","started_at":"2026-10-20T10:00:00-03:00","mode":"live"})" << '\n';
        f << R"({"type":"turn","t":3000,"t0":1000,"src":"outros","seq":1,"text":"Tem desconto à vista?"})" << '\n';
        f << R"({"type":"turn","t":5000,"t0":4000,"src":"voce","seq":2,"text":"Te)"; // torn by a crash
    }
    EXPECT_EQ(SessionStore::recover_incomplete(dir), 1);
    std::size_t bad = 0;
    const auto records = SessionStore::load(file, &bad);
    EXPECT_EQ(bad, 1u); // the torn line is skipped, not fatal
    ASSERT_GE(records.size(), 3u);
    EXPECT_EQ(records.back()["type"].as_string(), "session_end");
    EXPECT_EQ(records.back()["reason"].as_string(), "recovered");
    EXPECT_TRUE(fs::exists(dir / "crashed.md"));
    // Second run: nothing left to recover.
    EXPECT_EQ(SessionStore::recover_incomplete(dir), 0);
    fs::remove_all(dir);
}

TEST(SessionStore, RecoverySkipsTheLiveSession) {
    const fs::path dir = fresh_dir("skip");
    SessionStoreConfig cfg;
    cfg.dir = dir;
    SessionStore store{cfg};
    ASSERT_TRUE(store.open(meta("live")));
    EXPECT_EQ(SessionStore::recover_incomplete(dir, store.jsonl_path()), 0);
    store.close();
    fs::remove_all(dir);
}

TEST(SessionStore, Iso8601HasNumericOffset) {
    const std::string s = SessionStore::iso8601_now();
    ASSERT_EQ(s.size(), std::string("2026-10-20T21:50:03-03:00").size()) << s;
    EXPECT_EQ(s[10], 'T');
    EXPECT_TRUE(s[19] == '+' || s[19] == '-') << s;
    EXPECT_EQ(s[22], ':') << s;
}

TEST(SessionStore, MakesSortableUniqueIds) {
    const std::string a = SessionStore::make_session_id();
    ASSERT_EQ(a.size(), std::string("2026-10-20_21-50-03_7f3a").size());
    EXPECT_EQ(a[4], '-');
    EXPECT_EQ(a[10], '_');
    EXPECT_EQ(a[19], '_');
}
