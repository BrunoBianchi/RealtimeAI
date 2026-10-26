// Pure core: incremental Server-Sent Events parser (WHATWG event-stream).
// Bytes can be split anywhere between reads (mid-line, between CR and LF).
// Comment lines (": OPENROUTER PROCESSING") are reported separately so the
// UI can treat them as "still working".
#pragma once

#include <string>
#include <string_view>

namespace rtai {

class SseParser {
public:
    struct Event {
        std::string event; // "message" when not set by the stream
        std::string data;  // data lines joined with '\n'
        std::string id;
    };

    // Feeds a chunk. on_event(const Event&) is called for each complete event,
    // on_comment(std::string_view) for each comment line.
    template <class OnEvent, class OnComment>
    void feed(std::string_view chunk, OnEvent&& on_event, OnComment&& on_comment) {
        for (char c : chunk) {
            if (skip_lf_) {
                skip_lf_ = false;
                if (c == '\n') continue;
            }
            if (c == '\r' || c == '\n') {
                if (c == '\r') skip_lf_ = true;
                process_line(on_event, on_comment);
                line_.clear();
            } else {
                line_.push_back(c);
            }
        }
    }

    template <class OnEvent>
    void feed(std::string_view chunk, OnEvent&& on_event) {
        feed(chunk, std::forward<OnEvent>(on_event), [](std::string_view) {});
    }

    void reset() {
        line_.clear();
        data_.clear();
        event_.clear();
        id_.clear();
        has_data_ = false;
        skip_lf_ = false;
    }

private:
    template <class OnEvent, class OnComment>
    void process_line(OnEvent& on_event, OnComment& on_comment) {
        if (line_.empty()) { // blank line: dispatch
            if (has_data_) {
                Event ev;
                ev.event = event_.empty() ? "message" : event_;
                ev.data = data_;
                ev.id = id_;
                on_event(ev);
            }
            data_.clear();
            event_.clear();
            has_data_ = false;
            return;
        }
        if (line_.front() == ':') {
            std::string_view c(line_);
            c.remove_prefix(1);
            if (!c.empty() && c.front() == ' ') c.remove_prefix(1);
            on_comment(c);
            return;
        }
        std::string_view field(line_);
        std::string_view value;
        const auto colon = field.find(':');
        if (colon != std::string_view::npos) {
            value = field.substr(colon + 1);
            field = field.substr(0, colon);
            if (!value.empty() && value.front() == ' ') value.remove_prefix(1);
        }
        if (field == "data") {
            if (has_data_) data_.push_back('\n');
            data_.append(value);
            has_data_ = true;
        } else if (field == "event") {
            event_.assign(value);
        } else if (field == "id") {
            id_.assign(value);
        }
        // "retry" and unknown fields are ignored.
    }

    std::string line_;
    std::string data_;
    std::string event_;
    std::string id_;
    bool has_data_{false};
    bool skip_lf_{false};
};

} // namespace rtai
