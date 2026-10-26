#include <gtest/gtest.h>

#include "rtai/deepgram_protocol.hpp"

using namespace rtai::dg;

TEST(DeepgramUrl, BuildsNova3LinearParams) {
    StreamParams p; // defaults
    const std::string path = build_listen_path(p);
    EXPECT_NE(path.find("/v1/listen"), std::string::npos);
    EXPECT_NE(path.find("model=nova-3"), std::string::npos);
    EXPECT_NE(path.find("encoding=linear16"), std::string::npos);
    EXPECT_NE(path.find("sample_rate=16000"), std::string::npos);
    EXPECT_NE(path.find("channels=1"), std::string::npos);
    EXPECT_NE(path.find("interim_results=true"), std::string::npos);
}

TEST(DeepgramUrl, IncludesLanguageWhenSet) {
    StreamParams p;
    p.language = "multi";
    EXPECT_NE(build_listen_path(p).find("language=multi"), std::string::npos);
}

TEST(DeepgramUrl, OmitsLanguageWhenEmpty) {
    StreamParams p;
    EXPECT_EQ(build_listen_path(p).find("language="), std::string::npos);
}

TEST(DeepgramParse, ParsesFinalTranscript) {
    const char* msg = R"({
        "type":"Results",
        "is_final":true,
        "speech_final":true,
        "channel":{"alternatives":[{"transcript":"hello world","confidence":0.9}]}
    })";
    auto r = parse_transcript(msg);
    ASSERT_TRUE(r.valid);
    EXPECT_TRUE(r.is_final);
    EXPECT_TRUE(r.speech_final);
    EXPECT_EQ(r.transcript, "hello world");
}

TEST(DeepgramParse, ParsesInterimTranscript) {
    const char* msg = R"({
        "type":"Results",
        "is_final":false,
        "channel":{"alternatives":[{"transcript":"partial"}]}
    })";
    auto r = parse_transcript(msg);
    ASSERT_TRUE(r.valid);
    EXPECT_FALSE(r.is_final);
    EXPECT_EQ(r.transcript, "partial");
}

TEST(DeepgramParse, IgnoresMetadataMessages) {
    const char* msg = R"({"type":"Metadata","request_id":"abc"})";
    auto r = parse_transcript(msg);
    EXPECT_FALSE(r.valid);
}

TEST(DeepgramParse, InvalidJsonIsNotValid) {
    auto r = parse_transcript("not json");
    EXPECT_FALSE(r.valid);
}

TEST(KeepAlive, FiresOnlyDuringSilenceAfterInterval) {
    KeepAlivePolicy ka{5000}; // 5 s interval in ms
    // Active audio: never fires.
    ka.on_audio_sent(1000);
    EXPECT_FALSE(ka.should_send(2000));

    // Enter silence at t=2000; too soon at 4000.
    ka.on_silence(2000);
    EXPECT_FALSE(ka.should_send(4000));
    // At 7000 (>= 5 s after last activity 1000) it should fire once.
    EXPECT_TRUE(ka.should_send(7000));
    // Immediately after, not again until another interval.
    EXPECT_FALSE(ka.should_send(7500));
    EXPECT_TRUE(ka.should_send(12500));
}

TEST(KeepAlive, ControlMessagesAreJsonText) {
    EXPECT_EQ(keepalive_message(), R"({"type":"KeepAlive"})");
    EXPECT_EQ(close_stream_message(), R"({"type":"CloseStream"})");
}

TEST(DeepgramUrl, IncludesStreamingTuningParams) {
    StreamParams p;
    p.language = "pt-BR";
    p.endpointing_ms = 300;
    p.utterance_end_ms = 500; // clamped to the 1000 ms minimum
    p.vad_events = true;
    p.keyterms = {"RealTime AI", "Nova-3"};
    const std::string path = build_listen_path(p);
    EXPECT_NE(path.find("language=pt-BR"), std::string::npos);
    EXPECT_NE(path.find("smart_format=true"), std::string::npos);
    EXPECT_NE(path.find("endpointing=300"), std::string::npos);
    EXPECT_NE(path.find("utterance_end_ms=1000"), std::string::npos);
    EXPECT_NE(path.find("vad_events=true"), std::string::npos);
    EXPECT_NE(path.find("keyterm=RealTime%20AI"), std::string::npos);
    EXPECT_NE(path.find("keyterm=Nova-3"), std::string::npos);
}

TEST(DeepgramUrl, EndpointingCanBeDisabled) {
    StreamParams p;
    p.endpointing_ms = 0;
    EXPECT_NE(build_listen_path(p).find("endpointing=false"), std::string::npos);
    p.endpointing_ms.reset();
    EXPECT_EQ(build_listen_path(p).find("endpointing="), std::string::npos);
}

TEST(DeepgramParse, ParsesFinalizeFlagAndTiming) {
    auto m = parse_message(R"({"type":"Results","is_final":true,"from_finalize":true,
        "start":1.5,"duration":0.75,
        "channel":{"alternatives":[{"transcript":"qual o prazo?","confidence":0.93}]}})");
    ASSERT_EQ(m.kind, MessageKind::Results);
    EXPECT_TRUE(m.from_finalize);
    EXPECT_NEAR(m.start, 1.5, 1e-9);
    EXPECT_NEAR(m.duration, 0.75, 1e-9);
    EXPECT_NEAR(m.confidence, 0.93, 1e-9);
    EXPECT_EQ(m.transcript, "qual o prazo?");
}

TEST(DeepgramParse, ParsesUtteranceEndSpeechStartedMetadataAndErrors) {
    auto ue = parse_message(R"({"type":"UtteranceEnd","channel":[0,1],"last_word_end":2.395})");
    EXPECT_EQ(ue.kind, MessageKind::UtteranceEnd);
    EXPECT_NEAR(ue.last_word_end, 2.395, 1e-9);

    auto ss = parse_message(R"({"type":"SpeechStarted","channel":[0,1],"timestamp":4.2})");
    EXPECT_EQ(ss.kind, MessageKind::SpeechStarted);

    auto md = parse_message(R"({"type":"Metadata","request_id":"abc-123"})");
    EXPECT_EQ(md.kind, MessageKind::Metadata);
    EXPECT_EQ(md.request_id, "abc-123");

    auto err = parse_message(R"({"type":"Error","description":"bad audio"})");
    EXPECT_EQ(err.kind, MessageKind::Error);
    EXPECT_EQ(err.error, "bad audio");

    auto legacy = parse_message(R"({"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."})");
    EXPECT_EQ(legacy.kind, MessageKind::Error);
    EXPECT_EQ(legacy.error, "Invalid credentials.");
}

TEST(DeepgramProtocol, FinalizeMessageIsJsonText) {
    EXPECT_EQ(finalize_message(), R"({"type":"Finalize"})");
}

TEST(DeepgramProtocol, DescribesNet0001Close) {
    const std::string d = describe_close(1011, "NET-0001");
    EXPECT_NE(d.find("1011"), std::string::npos);
    EXPECT_NE(d.find("KeepAlive"), std::string::npos);
}

TEST(KeepAlive, FiresWhenIdleEvenWithoutAnyAudio) {
    // Idle loopback: no audio ever. The timer alone must make it due.
    KeepAlivePolicy ka{3000};
    ka.on_write(0); // connection opened
    EXPECT_FALSE(ka.should_send(2999));
    EXPECT_TRUE(ka.should_send(3000));
    EXPECT_EQ(ka.next_due(), 6000u);
    ka.on_write(4000); // audio resets the idle timer
    EXPECT_FALSE(ka.due(6500));
    EXPECT_TRUE(ka.due(7000));
}
