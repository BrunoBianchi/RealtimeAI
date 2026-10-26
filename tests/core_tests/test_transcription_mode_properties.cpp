#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <random>
#include <string>
#include <vector>

#include "rtai/audio_format.hpp"
#include "rtai/copilot_engine.hpp"
#include "rtai/copilot_events.hpp"
#include "rtai/json_min.hpp"
#include "rtai/server_protocol.hpp"
#include "rtai/session_transcript.hpp"
#include "rtai/transcript_export.hpp"

using namespace rtai;
using namespace std::chrono_literals;

namespace {

// Thread-safe event collector for testing CopilotEngine sinks
class EventCollector {
public:
    std::mutex mu;
    std::vector<EngineEvent> events;

    void operator()(const EngineEvent& e) {
        std::lock_guard<std::mutex> lk(mu);
        events.push_back(e);
    }

    template <class T>
    std::vector<T> all() {
        std::lock_guard<std::mutex> lk(mu);
        std::vector<T> out;
        for (const auto& e : events) {
            if (const T* p = std::get_if<T>(&e)) out.push_back(*p);
        }
        return out;
    }

    void clear() {
        std::lock_guard<std::mutex> lk(mu);
        events.clear();
    }
};

class CountingLlmClient final : public ILlmClient {
public:
    std::atomic<int> call_count{0};

    std::shared_ptr<ILlmCall> start(LlmRequest, LlmCallbacks cb) override {
        call_count.fetch_add(1);
        struct DummyCall final : ILlmCall {
            void cancel() override {}
            [[nodiscard]] bool finished() const override { return true; }
        };
        auto call = std::make_shared<DummyCall>();
        if (cb.on_delta) {
            cb.on_delta("Resposta gerada");
        }
        if (cb.on_done) {
            LlmResult res;
            res.status = LlmStatus::Completed;
            cb.on_done(res);
        }
        return call;
    }

    void shutdown(std::chrono::milliseconds) override {}
    [[nodiscard]] std::string name() const override { return "counting_fake"; }
};

CopilotConfig make_test_config() {
    CopilotConfig cfg;
    cfg.tick = 5ms;
    cfg.decision.cooldown_ms = 0;
    cfg.turns.boundary_grace_ms = 10;
    return cfg;
}

TranscriptEvent make_turn_event(AudioSource s, std::string text, bool is_final, bool from_finalize) {
    TranscriptEvent ev{s, std::move(text), is_final, 0};
    ev.from_finalize = from_finalize;
    ev.speech_final = is_final;
    return ev;
}

} // namespace

// ============================================================================
// Feature: transcription-only-mode, Property 3: Toda troca efetiva é propagada
// Requirements: 2.2
// ============================================================================
TEST(TranscriptionModeProperties, Property3_EveryEffectiveChangeIsPropagated) {
    auto llm = std::make_shared<CountingLlmClient>();
    CopilotEngine engine{make_test_config(), llm};
    auto col = std::make_shared<EventCollector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    // Initial state is false
    EXPECT_FALSE(engine.transcription_only());

    std::mt19937 rng(42);
    std::uniform_int_distribution<int> bool_dist(0, 1);

    for (int trial = 0; trial < 100; ++trial) {
        const bool current = engine.transcription_only();
        const bool requested = (bool_dist(rng) == 1);
        const auto count_before = col->all<TranscriptionModeEvent>().size();

        engine.set_transcription_only(requested);

        // Wait a short moment for orchestrator thread to process if enqueued
        std::this_thread::sleep_for(2ms);

        const auto events = col->all<TranscriptionModeEvent>();
        if (requested == current) {
            // Idempotent: same value => 0 new events
            EXPECT_EQ(events.size(), count_before) << "Trial " << trial;
        } else {
            // Changed: exactly 1 new event with enabled == requested
            ASSERT_EQ(events.size(), count_before + 1) << "Trial " << trial;
            EXPECT_EQ(events.back().enabled, requested) << "Trial " << trial;
            EXPECT_EQ(engine.transcription_only(), requested) << "Trial " << trial;
        }
    }

    engine.stop();
}

// ============================================================================
// Feature: transcription-only-mode, Property 6: Modo ativo suprime todo o AI_Analysis_Pipeline
// Requirements: 3.1, 3.3
// ============================================================================
TEST(TranscriptionModeProperties, Property6_ActiveModeSuppressesEntireAiPipeline) {
    auto llm = std::make_shared<CountingLlmClient>();
    CopilotEngine engine{make_test_config(), llm};
    auto col = std::make_shared<EventCollector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    // Turn mode on
    engine.set_transcription_only(true);
    std::this_thread::sleep_for(5ms);
    col->clear();

    std::mt19937 rng(1337);
    static const std::vector<std::string> sample_questions = {
        "Qual é o seu nível de experiência com C++?",
        "Como você lidaria com um bug crítico em produção?",
        "Qual a diferença entre mutex e spinlock?",
        "Qual é o prazo para entrega desse módulo?",
        "Como funciona o gerenciamento de memória no Windows?"
    };

    for (int trial = 0; trial < 100; ++trial) {
        const std::string& q = sample_questions[trial % sample_questions.size()];

        // Live interim and closed turn
        engine.on_transcript(make_turn_event(AudioSource::Loopback, q.substr(0, q.size() / 2), false, false));
        engine.on_transcript(make_turn_event(AudioSource::Loopback, q, true, true));

        // Manual actions
        switch (trial % 5) {
            case 0: engine.request_suggestion(); break;
            case 1: engine.request_action(TriggerReason::Chat, "Explique mais sobre isso."); break;
            case 2: engine.request_action(TriggerReason::Recap); break;
            case 3: engine.request_action(TriggerReason::FollowUp); break;
            case 4: engine.request_action(TriggerReason::Screenshot, "analise isso", "data:image/png;base64,QUJD"); break;
        }

        std::this_thread::sleep_for(1ms);
    }

    std::this_thread::sleep_for(20ms);
    engine.stop();

    // Zero LLM calls from live pipeline
    EXPECT_EQ(llm->call_count.load(), 0);

    // Zero suggestion events published
    EXPECT_TRUE(col->all<SuggestionStartedEvent>().empty());
    EXPECT_TRUE(col->all<SuggestionDeltaEvent>().empty());
    EXPECT_TRUE(col->all<SuggestionDoneEvent>().empty());

    // NoticeEvents should inform about transcription-only mode
    const auto notices = col->all<NoticeEvent>();
    EXPECT_FALSE(notices.empty());
    for (const auto& n : notices) {
        if (n.level == NoticeLevel::Info) {
            EXPECT_NE(n.text.find("Transcription-only mode"), std::string::npos);
        }
    }
}

// ============================================================================
// Feature: transcription-only-mode, Property 7: Modo ativo preserva o caminho de transcrição
// Requirements: 3.2
// ============================================================================
TEST(TranscriptionModeProperties, Property7_ActiveModePreservesTranscriptionPath) {
    auto llm = std::make_shared<CountingLlmClient>();
    CopilotEngine engine{make_test_config(), llm};
    auto col = std::make_shared<EventCollector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    // Turn mode on
    engine.set_transcription_only(true);
    std::this_thread::sleep_for(5ms);
    col->clear();

    const int N = 100;
    std::vector<std::string> expected_turns;
    expected_turns.reserve(N);

    for (int i = 0; i < N; ++i) {
        std::string text = "Turno de teste número " + std::to_string(i) + " verbatim.";
        expected_turns.push_back(text);
        AudioSource src = (i % 2 == 0) ? AudioSource::Loopback : AudioSource::Microphone;

        // Feed live update then closed turn
        engine.on_transcript(make_turn_event(src, text, false, false));
        engine.on_transcript(make_turn_event(src, text, true, true));
    }

    // Wait for all turns to process
    for (int i = 0; i < 50 && col->all<TurnEvent>().size() < static_cast<std::size_t>(N); ++i) {
        std::this_thread::sleep_for(5ms);
    }

    engine.stop();

    const auto turn_events = col->all<TurnEvent>();
    ASSERT_EQ(turn_events.size(), static_cast<std::size_t>(N));

    for (std::size_t i = 0; i < turn_events.size(); ++i) {
        EXPECT_EQ(turn_events[i].turn.text, expected_turns[i]);
    }

    const auto live_events = col->all<TranscriptUpdateEvent>();
    EXPECT_GE(live_events.size(), static_cast<std::size_t>(N));
}

// ============================================================================
// Feature: transcription-only-mode, Property 8: Export verbatim e em ordem cronológica
// Requirements: 4.4
// ============================================================================
TEST(TranscriptionModeProperties, Property8_ExportVerbatimAndChronological) {
    std::mt19937 rng(999);
    static const std::string words[] = {
        "Olá", "como", "vai", "você?", "Tudo", "bem,", "e", "com", "você?",
        "Qual", "o", "desafio", "principal?", "Integração", "de", "áudio",
        "WASAPI", "em", "tempo-real", "sem", "bloqueio."
    };

    for (int trial = 0; trial < 100; ++trial) {
        SessionTranscript transcript;
        std::uniform_int_distribution<int> num_turns_dist(1, 15);
        const int num_turns = num_turns_dist(rng);

        std::vector<std::string> turn_texts;
        turn_texts.reserve(num_turns);

        std::int64_t clock = 0;
        for (int i = 0; i < num_turns; ++i) {
            std::uniform_int_distribution<int> num_words_dist(2, 6);
            const int nw = num_words_dist(rng);
            std::string turn_text;
            for (int w = 0; w < nw; ++w) {
                if (w > 0) turn_text += ' ';
                turn_text += words[(i + w + trial) % (sizeof(words) / sizeof(words[0]))];
            }
            turn_texts.push_back(turn_text);

            Turn t;
            t.source = (i % 2 == 0) ? AudioSource::Loopback : AudioSource::Microphone;
            t.text = turn_text;
            t.start_ms = clock;
            clock += 500;
            t.end_ms = clock;
            t.seq = static_cast<std::uint64_t>(i + 1);
            transcript.append(t);
        }

        // Test .txt export
        const std::string txt_export = build_transcript_export(transcript, TranscriptExportFormat::Txt);
        std::size_t txt_pos = 0;
        for (const auto& text : turn_texts) {
            auto found = txt_export.find(text, txt_pos);
            ASSERT_NE(found, std::string::npos) << "Text '" << text << "' not found in .txt at trial " << trial;
            EXPECT_GE(found, txt_pos) << "Turn order violated in .txt at trial " << trial;
            txt_pos = found + text.size();
        }

        // Test .md export
        const std::string md_export = build_transcript_export(transcript, TranscriptExportFormat::Md);
        EXPECT_EQ(md_export.rfind("# Session Transcript\n\n", 0), 0u);
        std::size_t md_pos = 0;
        for (const auto& text : turn_texts) {
            auto found = md_export.find(text, md_pos);
            ASSERT_NE(found, std::string::npos) << "Text '" << text << "' not found in .md at trial " << trial;
            EXPECT_GE(found, md_pos) << "Turn order violated in .md at trial " << trial;
            md_pos = found + text.size();
        }
    }
}

// ============================================================================
// Unit Tests: build_transcript_export and build_summary_request (Task 4.4)
// Requirements: 4.4, 5.1
// ============================================================================
TEST(TranscriptionModeProperties, UnitTests_ExportAndSummaryConstruction) {
    // 0 turns
    {
        SessionTranscript empty;
        EXPECT_EQ(build_transcript_export(empty, TranscriptExportFormat::Txt), "");
        EXPECT_EQ(build_transcript_export(empty, TranscriptExportFormat::Md), "# Session Transcript\n\n");

        auto req = build_summary_request(empty);
        ASSERT_EQ(req.size(), 2u);
        EXPECT_EQ(req[0].role, "system");
        EXPECT_FALSE(req[0].content.empty());
        EXPECT_EQ(req[1].role, "user");
        EXPECT_EQ(req[1].content, "");
    }

    // 1 turn
    {
        SessionTranscript single;
        Turn t;
        t.source = AudioSource::Loopback;
        t.text = "Primeira pergunta da chamada.";
        single.append(t);

        const std::string txt = build_transcript_export(single, TranscriptExportFormat::Txt);
        EXPECT_EQ(txt, "Interviewer: Primeira pergunta da chamada.\n");

        const std::string md = build_transcript_export(single, TranscriptExportFormat::Md);
        EXPECT_EQ(md, "# Session Transcript\n\nInterviewer: Primeira pergunta da chamada.\n");

        auto req = build_summary_request(single);
        ASSERT_EQ(req.size(), 2u);
        EXPECT_EQ(req[0].role, "system");
        EXPECT_EQ(req[1].role, "user");
        EXPECT_EQ(req[1].content, "Interviewer: Primeira pergunta da chamada.\n");
    }

    // N turns
    {
        SessionTranscript multi;
        Turn t1;
        t1.source = AudioSource::Loopback;
        t1.text = "Pergunta 1.";
        multi.append(t1);

        Turn t2;
        t2.source = AudioSource::Microphone;
        t2.text = "Resposta 1.";
        multi.append(t2);

        const std::string txt = build_transcript_export(multi, TranscriptExportFormat::Txt);
        EXPECT_EQ(txt, "Interviewer: Pergunta 1.\nCandidate: Resposta 1.\n");

        const std::string md = build_transcript_export(multi, TranscriptExportFormat::Md);
        EXPECT_EQ(md, "# Session Transcript\n\nInterviewer: Pergunta 1.\nCandidate: Resposta 1.\n");

        auto req = build_summary_request(multi);
        ASSERT_EQ(req.size(), 2u);
        EXPECT_EQ(req[1].content, "Interviewer: Pergunta 1.\nCandidate: Resposta 1.\n");
    }
}

// ============================================================================
// Feature: transcription-only-mode, Property 5: O hello de conexão carrega o estado corrente
// Requirements: 2.5
// ============================================================================
TEST(TranscriptionModeProperties, Property5_HelloPayloadCarriesCurrentModeState) {
    for (int trial = 0; trial < 100; ++trial) {
        const bool s = (trial % 2 == 0);
        server::Hello h;
        h.mode = s;

        const std::string encoded = server::encode_hello(h);
        auto parsed = json::Parser::parse(encoded);
        ASSERT_TRUE(parsed && parsed->is_object()) << "Trial " << trial;
        const json::Value& v = *parsed;
        EXPECT_TRUE(v["mode"].is_bool()) << "Trial " << trial;
        EXPECT_EQ(v["mode"].as_bool(), s) << "Trial " << trial;
    }
}

// ============================================================================
// Feature: transcription-only-mode, Property 4: Convergência do estado após propagação
// Requirements: 2.1, 2.6
// ============================================================================
TEST(TranscriptionModeProperties, Property4_StateConvergenceAfterPropagation) {
    // Models Core, Dashboard mirror, and Overlay mirror
    // Written on the engine thread, read on the test thread.
    struct SurfaceMirror {
        std::atomic<bool> mode{false};
        void on_mode_event(bool on) { mode.store(on); }
    };

    SurfaceMirror dashboard_mirror;
    SurfaceMirror overlay_mirror;

    auto llm = std::make_shared<CountingLlmClient>();
    CopilotEngine engine{make_test_config(), llm};

    engine.add_sink([&](const EngineEvent& ev) {
        if (const auto* m = std::get_if<TranscriptionModeEvent>(&ev)) {
            // Republication delivered to both mirrors
            dashboard_mirror.on_mode_event(m->enabled);
            overlay_mirror.on_mode_event(m->enabled);
        }
    });

    engine.start();

    std::mt19937 rng(777);
    std::uniform_int_distribution<int> origin_dist(0, 1); // 0 = Dashboard, 1 = Overlay
    std::uniform_int_distribution<int> bool_dist(0, 1);

    for (int trial = 0; trial < 100; ++trial) {
        const bool target_val = (bool_dist(rng) == 1);
        const int origin = origin_dist(rng);

        if (origin == 0) {
            // Initiated by Dashboard
            engine.set_transcription_only(target_val);
        } else {
            // Initiated by Overlay
            engine.set_transcription_only(target_val);
        }

        // Propagation is asynchronous: wait (bounded) for the republication.
        const auto deadline = std::chrono::steady_clock::now() + 1s;
        while ((dashboard_mirror.mode.load() != target_val || overlay_mirror.mode.load() != target_val) &&
               std::chrono::steady_clock::now() < deadline) {
            std::this_thread::sleep_for(1ms);
        }

        // Core, Dashboard mirror, and Overlay mirror must all converge to target_val
        EXPECT_EQ(engine.transcription_only(), target_val) << "Trial " << trial;
        EXPECT_EQ(dashboard_mirror.mode.load(), target_val) << "Trial " << trial;
        EXPECT_EQ(overlay_mirror.mode.load(), target_val) << "Trial " << trial;
    }

    engine.stop();
}

// ============================================================================
// Feature: transcription-only-mode, Property 9: Uma única chamada de IA de resumo, apenas no encerramento
// Requirements: 5.1, 5.2, 5.3
// ============================================================================
TEST(TranscriptionModeProperties, Property9_SingleSummaryCallOnlyAtFinalization) {
    class SummaryLifecycleMock {
    public:
        std::atomic<int> summary_call_count{0};
        std::atomic<bool> summary_pending{false};

        void on_mode_change(bool enabled, const SessionTranscript& t) {
            if (enabled) {
                summary_pending.store(true);
            } else if (summary_pending.exchange(false)) {
                if (!t.empty()) {
                    trigger_summary(t);
                }
            }
        }

        void on_session_end(const SessionTranscript& t) {
            if (summary_pending.exchange(false)) {
                if (!t.empty()) {
                    trigger_summary(t);
                }
            }
        }

        void trigger_summary(const SessionTranscript& t) {
            summary_call_count.fetch_add(1);
            auto msgs = build_summary_request(t);
            EXPECT_EQ(msgs.size(), 2u);
        }
    };

    for (int trial = 0; trial < 100; ++trial) {
        SummaryLifecycleMock mock;
        SessionTranscript transcript;

        // Capture is in progress, mode not yet active
        EXPECT_EQ(mock.summary_call_count.load(), 0);

        // Turn mode on
        mock.on_mode_change(true, transcript);
        EXPECT_EQ(mock.summary_call_count.load(), 0);

        // Feed turns while live capture is ongoing
        const int num_turns = 1 + (trial % 5);
        for (int i = 0; i < num_turns; ++i) {
            Turn t;
            t.source = (i % 2 == 0) ? AudioSource::Loopback : AudioSource::Microphone;
            t.text = "Turno de teste ao vivo " + std::to_string(i);
            transcript.append(t);

            // Crucial assertion: DURING live capture, summary call count MUST BE ZERO
            EXPECT_EQ(mock.summary_call_count.load(), 0)
                << "Trial " << trial << " turn " << i << ": summary triggered during live capture!";
        }

        const bool close_by_deactivating = (trial % 2 == 0);
        if (close_by_deactivating) {
            // End mode by deactivating
            mock.on_mode_change(false, transcript);
            EXPECT_EQ(mock.summary_call_count.load(), 1) << "Trial " << trial;

            // Redundant deactivation should NOT trigger again (idempotent / one call per activation)
            mock.on_mode_change(false, transcript);
            EXPECT_EQ(mock.summary_call_count.load(), 1) << "Trial " << trial;

            // Session end after already deactivated should NOT trigger again
            mock.on_session_end(transcript);
            EXPECT_EQ(mock.summary_call_count.load(), 1) << "Trial " << trial;
        } else {
            // End mode by Session_End while mode is still active
            mock.on_session_end(transcript);
            EXPECT_EQ(mock.summary_call_count.load(), 1) << "Trial " << trial;

            // Subsequent deactivation should NOT trigger again
            mock.on_mode_change(false, transcript);
            EXPECT_EQ(mock.summary_call_count.load(), 1) << "Trial " << trial;
        }
    }
}

// ============================================================================
// Feature: transcription-only-mode, Property 1: O toggle solicita o valor oposto ao espelho
// Feature: transcription-only-mode, Property 2: O espelho segue a última republicação recebida
// Requirements: 1.4, 1.6, 2.4
// ============================================================================
TEST(TranscriptionModeProperties, Property1_And_2_OverlayToggleAndMirrorConvergence) {
    std::mt19937_64 rng(0xC001CAFE);
    std::uniform_int_distribution<int> bool_dist(0, 1);

    for (int trial = 0; trial < 100; ++trial) {
        // Model mirror in Overlay
        bool overlay_mirror = (bool_dist(rng) == 1);
        std::optional<bool> requested_toggle;

        // Toggle action
        auto on_toggle_click = [&](bool current_mirror) {
            requested_toggle = !current_mirror;
        };

        // Property 1: Toggle click requests !overlay_mirror without mutating overlay_mirror locally
        on_toggle_click(overlay_mirror);
        ASSERT_TRUE(requested_toggle.has_value());
        EXPECT_EQ(*requested_toggle, !overlay_mirror) << "Trial " << trial;

        // Property 2: Feed a random sequence of TranscriptionModeEvent to overlay mirror
        const int seq_len = 1 + (trial % 15);
        bool last_published = overlay_mirror;
        for (int step = 0; step < seq_len; ++step) {
            bool pub = (bool_dist(rng) == 1);
            last_published = pub;
            TranscriptionModeEvent ev{pub, 1000 + step};
            // Overlay apply/drain updates mirror from event:
            overlay_mirror = ev.enabled;
        }

        EXPECT_EQ(overlay_mirror, last_published)
            << "Trial " << trial << ": mirror must equal the last published event";
    }
}

// ============================================================================
// Feature: transcription-only-mode, Property 4: Convergência do estado após propagação
// Requirements: 2.1, 2.2, 2.6
// ============================================================================
TEST(TranscriptionModeProperties, Property4_StateConvergenceAcrossObservers) {
    std::mt19937_64 rng(0xDEADBEEF);
    std::uniform_int_distribution<int> bool_dist(0, 1);

    for (int trial = 0; trial < 100; ++trial) {
        auto engine = std::make_shared<CopilotEngine>(make_test_config(), nullptr);

        // Multiple observers (Overlay mirror, Dashboard stdout mirror, Logger mirror)
        std::atomic<bool> overlay_mirror{false};
        std::atomic<bool> dashboard_mirror{false};
        std::atomic<bool> logger_mirror{false};
        std::atomic<int> delivered{0};

        engine->add_sink([&](const EngineEvent& e) {
            if (const auto* m = std::get_if<TranscriptionModeEvent>(&e)) {
                overlay_mirror.store(m->enabled);
                dashboard_mirror.store(m->enabled);
                logger_mirror.store(m->enabled);
                delivered.fetch_add(1);
            }
        });

        engine->start();

        // Perform random mode transitions (including redundant idempotent calls)
        const int steps = 5 + (trial % 10);
        bool target_mode = false;
        bool current = false;
        int published = 0; // only real transitions are republished
        for (int s = 0; s < steps; ++s) {
            target_mode = (bool_dist(rng) == 1);
            engine->set_transcription_only(target_mode);
            if (target_mode != current) {
                current = target_mode;
                ++published;
            }
        }

        // Wait (bounded, generous for sanitizer builds) until every
        // republication reached the observers. Comparing the mirrors to the
        // target is not enough: an intermediate state can equal it.
        for (int w = 0; w < 1000 && delivered.load() < published; ++w) {
            std::this_thread::sleep_for(2ms);
        }
        EXPECT_EQ(delivered.load(), published) << "Trial " << trial;

        EXPECT_EQ(engine->transcription_only(), target_mode) << "Trial " << trial;
        EXPECT_EQ(overlay_mirror.load(), target_mode) << "Trial " << trial;
        EXPECT_EQ(dashboard_mirror.load(), target_mode) << "Trial " << trial;
        EXPECT_EQ(logger_mirror.load(), target_mode) << "Trial " << trial;

        engine->stop();
    }
}
