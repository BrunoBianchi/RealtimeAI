// Pure core — the Cold_Path analytics seam.
//
// The CopilotEngine (rtai_core) must NOT depend on rtai_net, so it never
// constructs a concrete JevAnalyticsClient. Instead it talks to this small
// abstract interface: on the Finalize action it hands the engine-owned
// SessionTranscript to finalize() and gets an all-or-nothing callback back on
// a worker thread. The concrete JevAnalyticsClient in rtai_net implements this
// interface, wired at the application layer (main.cpp).
//
// finalize(transcript, on_done):
//   * Fans out the Cold_Path work (two parallel calls in the Jev client) and
//     invokes on_done(ok, report) when the join resolves.
//   * on_done arrives on a Cold_Path worker thread, NOT the orchestrator thread,
//     so the engine routes it back onto its inbox before touching any state.
//   * ok == true ONLY on the double-success join; on any failure/timeout ok is
//     false and `report` is discarded (Req 8.3/8.4).
//
// All types here are core-only (SessionTranscript, JevReport), so including
// this header pulls in no platform or net dependency.
#pragma once

#include <functional>

#include "rtai/overlay_mode.hpp"       // JevReport
#include "rtai/session_transcript.hpp" // SessionTranscript

namespace rtai {

// Abstract Cold_Path client. Implemented by rtai_net's JevAnalyticsClient and
// injected into the CopilotEngine as a nullable std::shared_ptr (like ILlmClient).
struct IAnalyticsClient {
    virtual ~IAnalyticsClient() = default;

    // Req 7.1: start the Cold_Path for `transcript`. `on_done` is invoked once
    // with ok == true and a full `report` ONLY on the double-success join; on
    // any failure/timeout it is invoked with ok == false and an empty report.
    // The callback may run on any thread; callers that own single-threaded
    // state must hop back to their own thread inside it.
    virtual void finalize(const SessionTranscript& transcript,
                          std::function<void(bool ok, JevReport report)> on_done) = 0;
};

} // namespace rtai
