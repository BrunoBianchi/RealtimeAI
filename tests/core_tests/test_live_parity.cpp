// Parity between the engine and the lipcue.com live page (specs/005, US3):
// the site ports assess_question and build_copilot_messages to JavaScript
// (Browser/Home/src/lib/live). Both sides read the same fixtures in
// tests/fixtures/live_parity; this test fails when the engine and the
// fixtures (made from the JS port) disagree.
#include <gtest/gtest.h>

#include <fstream>
#include <sstream>
#include <string>

#include "rtai/copilot_prompt.hpp"
#include "rtai/json_min.hpp"
#include "rtai/question_gate.hpp"
#include "rtai/story_ledger.hpp"

#ifndef RTAI_LIVE_PARITY_DIR
#error "RTAI_LIVE_PARITY_DIR must point to tests/fixtures/live_parity"
#endif

using namespace rtai;

namespace {

json::Value load(const char* name) {
    const std::string path = std::string(RTAI_LIVE_PARITY_DIR) + "/" + name;
    std::ifstream in(path, std::ios::binary);
    EXPECT_TRUE(in.good()) << path;
    std::stringstream ss;
    ss << in.rdbuf();
    auto v = json::Parser::parse(ss.str());
    EXPECT_TRUE(v.has_value()) << path << " is not valid JSON";
    return v ? *v : json::Value{};
}

const char* verdict_name(QuestionVerdict v) {
    switch (v) {
        case QuestionVerdict::Ready: return "Ready";
        case QuestionVerdict::Wait:  return "Wait";
        case QuestionVerdict::Drop:  return "Drop";
    }
    return "?";
}

TriggerReason reason_of(const std::string& r) {
    if (r == "long_turn") return TriggerReason::LongTurn;
    if (r == "manual") return TriggerReason::Manual;
    if (r == "keyword") return TriggerReason::Keyword;
    if (r == "none") return TriggerReason::None;
    return TriggerReason::Question;
}

} // namespace

TEST(LiveParity, QuestionGateMatchesTheWebPort) {
    const auto cases = load("question_gate.json");
    ASSERT_GE(cases.size(), 40u);
    for (std::size_t i = 0; i < cases.size(); ++i) {
        const auto& c = cases.at(i);
        const std::string& text = c["text"].as_string();
        const bool ctx = c["has_context"].as_bool();
        const bool fin = c["final"].as_bool();
        const auto a = assess_question(text, ctx, fin);
        EXPECT_EQ(verdict_name(a.verdict), c["verdict"].as_string())
            << '"' << text << "\" context=" << ctx << " final=" << fin << " (" << a.reason << ")";
        EXPECT_EQ(a.explicit_question, c["explicit"].as_bool()) << '"' << text << '"';
    }
}

TEST(LiveParity, PromptMatchesTheWebPort) {
    const auto cases = load("prompt.json");
    ASSERT_GE(cases.size(), 1u);
    for (std::size_t i = 0; i < cases.size(); ++i) {
        const auto& c = cases.at(i);
        const std::string name = c["name"].as_string();
        ConversationLog log;
        const auto& turns = c["turns"];
        for (std::size_t k = 0; k < turns.size(); ++k) {
            Turn t;
            t.source = turns.at(k)["speaker"].as_string() == "Você" ? AudioSource::Microphone : AudioSource::Loopback;
            t.text = turns.at(k)["text"].as_string();
            log.add(t);
        }
        const std::string history = log.render(static_cast<std::size_t>(c["max_history_chars"].as_number()));
        EXPECT_EQ(history, c["history"].as_string()) << name << ": rendered history";

        PromptConfig cfg;
        const std::string profile = c["profile"].as_string();
        cfg.session_profile = [profile] { return profile; };
        const std::string retrieved = c["retrieved"].as_string();
        if (!retrieved.empty()) cfg.rag_retrieve = [retrieved](std::string_view, std::string_view) { return retrieved; };
        const auto msgs = build_copilot_messages(cfg, history, c["trigger"].as_string(),
                                                 reason_of(c["reason"].as_string()), {}, c["allow_skip"].as_bool(),
                                                 {}, c["story_ledger"].as_string());
        const auto& want = c["messages"];
        ASSERT_EQ(msgs.size(), want.size()) << name;
        for (std::size_t m = 0; m < msgs.size(); ++m) {
            EXPECT_EQ(msgs[m].role, want.at(m)["role"].as_string()) << name;
            EXPECT_EQ(msgs[m].content, want.at(m)["content"].as_string()) << name << ": message " << m;
        }
    }
}

TEST(LiveParity, StoryLedgerMatchesTheWebPort) {
    const auto cases = load("ledger.json");
    ASSERT_GE(cases.size(), 5u);
    for (std::size_t i = 0; i < cases.size(); ++i) {
        const auto& c = cases.at(i);
        const std::string name = c["name"].as_string();
        StoryLedgerConfig cfg;
        cfg.prompt_chars = static_cast<std::size_t>(c["prompt_chars"].as_number());
        StoryLedger l{cfg};
        const auto& ops = c["ops"];
        std::size_t adds = 0;
        for (std::size_t k = 0; k < ops.size(); ++k) {
            const auto& op = ops.at(k);
            if (op.has("add")) {
                const bool kept = l.add(op["add"].at(0).as_string(), op["add"].at(1).as_string());
                EXPECT_EQ(kept, c["added"].at(adds).as_bool()) << name << ": add " << adds;
                ++adds;
            } else if (op.has("prior")) {
                l.set_prior(op["prior"].as_string());
            } else if (op.has("summary")) {
                l.set_summary(static_cast<std::size_t>(op["summary"].at(0).as_number()), op["summary"].at(1).as_string());
            }
        }
        EXPECT_EQ(l.size(), static_cast<std::size_t>(c["size"].as_number())) << name;
        EXPECT_EQ(l.render(), c["render"].as_string()) << name << ": render";
        EXPECT_EQ(l.persistable(), c["persistable"].as_string()) << name << ": persistable";
        EXPECT_EQ(l.needs_compaction(), c["needs_compaction"].as_bool()) << name;
        const auto job = l.compaction_job(c["spoken"].as_string());
        EXPECT_EQ(job.covered, static_cast<std::size_t>(c["job_covered"].as_number())) << name;
        ASSERT_EQ(job.messages.size(), 2u);
        EXPECT_EQ(job.messages[0].content, c["job_system"].as_string()) << name;
        EXPECT_EQ(job.messages[1].content, c["job_user"].as_string()) << name << ": compaction request";
    }
}
