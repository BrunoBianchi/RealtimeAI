#include <gtest/gtest.h>

#include "rtai/vad_state_machine.hpp"

using namespace rtai;

TEST(VadStateMachine, ActivatesAfterThreshold) {
    VadConfig cfg;
    cfg.start_threshold = 0.5f;
    cfg.activation_windows = 1;
    VadStateMachine sm{cfg};

    auto d = sm.update(0.2f);
    EXPECT_FALSE(d.speech_active);
    EXPECT_FALSE(d.turn_opened);

    d = sm.update(0.8f);
    EXPECT_TRUE(d.speech_active);
    EXPECT_TRUE(d.turn_opened);
}

TEST(VadStateMachine, RequiresConsecutiveActivationWindows) {
    VadConfig cfg;
    cfg.start_threshold = 0.5f;
    cfg.activation_windows = 3;
    VadStateMachine sm{cfg};

    EXPECT_FALSE(sm.update(0.9f).speech_active); // 1
    EXPECT_FALSE(sm.update(0.9f).speech_active); // 2
    EXPECT_TRUE(sm.update(0.9f).speech_active);  // 3 -> active
}

TEST(VadStateMachine, HangoverKeepsSpeechThenCloses) {
    VadConfig cfg;
    cfg.start_threshold = 0.5f;
    cfg.stop_threshold = 0.35f;
    cfg.activation_windows = 1;
    cfg.hangover_windows = 3;
    VadStateMachine sm{cfg};

    ASSERT_TRUE(sm.update(0.9f).turn_opened); // active

    // Below stop threshold but within hangover: still active, not closed.
    EXPECT_TRUE(sm.update(0.1f).speech_active);
    EXPECT_TRUE(sm.update(0.1f).speech_active);
    auto d = sm.update(0.1f); // 3rd below -> close
    EXPECT_FALSE(d.speech_active);
    EXPECT_TRUE(d.turn_closed);
}

TEST(VadStateMachine, HangoverResetsOnActivity) {
    VadConfig cfg;
    cfg.start_threshold = 0.5f;
    cfg.stop_threshold = 0.35f;
    cfg.activation_windows = 1;
    cfg.hangover_windows = 3;
    VadStateMachine sm{cfg};

    ASSERT_TRUE(sm.update(0.9f).turn_opened);
    sm.update(0.1f); // below 1
    sm.update(0.1f); // below 2
    sm.update(0.9f); // activity resets hangover
    // Now it takes 3 more below-stop windows to close.
    EXPECT_TRUE(sm.update(0.1f).speech_active);
    EXPECT_TRUE(sm.update(0.1f).speech_active);
    EXPECT_TRUE(sm.update(0.1f).turn_closed == true);
}

TEST(VadStateMachine, ScriptedSilenceSpeechSilence) {
    VadStateMachine sm{VadConfig{0.5f, 0.35f, 1, 2}};
    const float script[] = {0.1f, 0.1f, 0.9f, 0.9f, 0.1f, 0.1f};
    bool ever_active = false, closed = false;
    for (float p : script) {
        auto d = sm.update(p);
        ever_active = ever_active || d.speech_active;
        closed = closed || d.turn_closed;
    }
    EXPECT_TRUE(ever_active);
    EXPECT_TRUE(closed);
    EXPECT_FALSE(sm.speech_active());
}
