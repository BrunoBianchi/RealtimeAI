#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace rtai::web {

// Performs a small, bounded public web search without requiring another API
// key. Returns plain-text facts suitable for adding to an LLM context.
std::string search(std::string_view query);

// Fast parallel company intelligence tool: queries Wikipedia PT/EN + DuckDuckGo
// concurrently (~1s max) and produces a structured Company Dossier & Cultural Fit
// playbook for the Mini-Agent.
std::string search_company(std::string_view company, std::string_view role = {});

struct CalendarEvent {
    std::string title;       // SUMMARY (e.g. "Entrevista Técnica - Nubank")
    std::string start_time;  // Formatted date/time (e.g. "22/10 14:00")
    std::string description; // DESCRIPTION / meeting notes
    std::string location;    // Meet link or location
    std::string company_hint;
    std::string role_hint;
};

// Fetches upcoming events from Google Calendar via either a private/public .ics
// URL (https://calendar.google.com/calendar/ical/.../basic.ics) or a Google
// OAuth2 Bearer access token (ya29...). Pure parser helpers are also exposed.
std::vector<CalendarEvent> parse_ics_events(std::string_view ics_body, std::size_t max_events = 15);
std::vector<CalendarEvent> fetch_google_calendar_events(std::string_view url_or_token,
                                                        std::string* error_out = nullptr);

} // namespace rtai::web
