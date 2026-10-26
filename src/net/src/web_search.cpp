#include "rtai/web_search.hpp"

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <cctype>
#include <future>
#include <string>
#include <vector>

#include "rtai/json_min.hpp"
#include "rtai/text_util.hpp"
#include "rtai/url.hpp"
#include "rtai/version.hpp"
#include "rtai/winhttp_util.hpp"

namespace rtai::web {
namespace {

std::string url_encode(std::string_view value) {
    static constexpr char hex[] = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : value) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 15]);
        }
    }
    return out;
}

void append_topic_text(const json::Value& topic, std::string& out) {
    const std::string text = topic["Text"].as_string();
    const std::string url = topic["FirstURL"].as_string();
    if (!text.empty()) {
        out += "- " + text;
        if (!url.empty()) out += " (" + url + ")";
        out.push_back('\n');
    }
    const auto& topics = topic["Topics"];
    for (std::size_t i = 0; i < topics.size(); ++i) append_topic_text(topics.at(i), out);
}

std::string http_get_string(const std::wstring& host, INTERNET_PORT port, bool secure,
                            const std::wstring& path, const std::wstring& extra_headers = {},
                            int timeout_ms = 1800, std::size_t max_bytes = 64000) {
    HINTERNET session = win::open_session(L"RealTimeAI/" RTAI_VERSION_WSTRING L" (WinHTTP)");
    if (!session) return {};
    win::enable_modern_tls(session);
    win::HInternet session_owner(session);
    WinHttpSetTimeouts(session, timeout_ms, timeout_ms, timeout_ms, timeout_ms);

    HINTERNET connection = WinHttpConnect(session, host.c_str(), port, 0);
    if (!connection) return {};
    win::HInternet connection_owner(connection);

    const DWORD flags = secure ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET request = WinHttpOpenRequest(connection, L"GET", path.c_str(), nullptr,
                                           WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!request) return {};
    win::HInternet request_owner(request);

    std::wstring headers = L"Accept: application/json, text/calendar, */*\r\n";
    headers += extra_headers;
    if (!WinHttpSendRequest(request, headers.c_str(), static_cast<DWORD>(-1L),
                            WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request, nullptr)) {
        return {};
    }
    if (win::query_status(request) != 200) return {};
    return win::read_body(request, max_bytes);
}

std::string query_wikipedia_extract(const std::wstring& wiki_host, std::string_view query) {
    const std::string encoded = url_encode(text::truncate_utf8(text::trim(query), 120));
    const std::wstring path = win::widen(
        "/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1"
        "&generator=search&gsrsearch=" + encoded + "&gsrlimit=2&format=json&formatversion=2");
    const std::string body = http_get_string(wiki_host, INTERNET_DEFAULT_HTTPS_PORT, true, path, {}, 1600, 32000);
    if (body.empty()) return {};
    auto parsed = json::Parser::parse(body);
    if (!parsed || !parsed->is_object()) return {};
    const auto& pages = (*parsed)["query"]["pages"];
    if (!pages.is_array()) return {};

    std::string out;
    for (std::size_t i = 0; i < pages.size(); ++i) {
        const auto& page_val = pages.at(i);
        if (!page_val.is_object()) continue;
        const std::string title = text::trim(page_val["title"].as_string());
        const std::string extract = text::trim(page_val["extract"].as_string());
        if (!extract.empty()) {
            if (!title.empty()) out += "• " + title + ": ";
            out += text::truncate_utf8(extract, 900) + "\n";
        }
    }
    return text::trim(out);
}

bool looks_like_url_or_domain(std::string_view raw, std::string& normalized_url, std::string& brand_name) {
    const std::string s = text::trim(raw);
    if (s.empty()) return false;
    bool has_scheme = s.rfind("http://", 0) == 0 || s.rfind("https://", 0) == 0;
    bool looks_domain = !has_scheme && s.find(' ') == std::string::npos &&
                        s.find('.') != std::string::npos && s.size() >= 4;
    if (!has_scheme && !looks_domain) return false;

    normalized_url = has_scheme ? s : ("https://" + s);
    const ParsedUrl pu = parse_url(normalized_url);
    if (!pu.ok || pu.host.empty()) return false;

    std::string host = pu.host;
    if (host.rfind("www.", 0) == 0) host.erase(0, 4);
    const auto dot = host.find('.');
    brand_name = dot != std::string::npos ? host.substr(0, dot) : host;
    if (!brand_name.empty()) {
        brand_name[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(brand_name[0])));
    }
    return true;
}

std::string strip_html_to_text(std::string_view html, std::size_t max_chars = 2200) {
    std::string out;
    out.reserve(std::min<std::size_t>(html.size(), 4096));
    bool in_tag = false;
    bool skip_block = false;
    std::string tag_name;
    for (std::size_t i = 0; i < html.size() && out.size() < max_chars * 2; ++i) {
        const char c = html[i];
        if (c == '<') {
            in_tag = true;
            tag_name.clear();
            continue;
        }
        if (c == '>') {
            in_tag = false;
            std::string lower_tag = text::fold(tag_name);
            if (lower_tag.rfind("script", 0) == 0 || lower_tag.rfind("style", 0) == 0 ||
                lower_tag.rfind("svg", 0) == 0 || lower_tag.rfind("noscript", 0) == 0) {
                skip_block = true;
            } else if (lower_tag.rfind("/script", 0) == 0 || lower_tag.rfind("/style", 0) == 0 ||
                       lower_tag.rfind("/svg", 0) == 0 || lower_tag.rfind("/noscript", 0) == 0) {
                skip_block = false;
            } else if (lower_tag == "p" || lower_tag == "/p" || lower_tag == "br" ||
                       lower_tag == "li" || lower_tag == "/h1" || lower_tag == "/h2" ||
                       lower_tag == "/h3" || lower_tag == "/div") {
                if (!out.empty() && out.back() != '\n') out.push_back('\n');
            }
            continue;
        }
        if (in_tag) {
            if (tag_name.size() < 16 && !std::isspace(static_cast<unsigned char>(c))) {
                tag_name.push_back(c);
            }
            continue;
        }
        if (skip_block) continue;
        if (c == '\r') continue;
        if (c == '\n' || c == '\t' || c == ' ') {
            if (!out.empty() && out.back() != ' ' && out.back() != '\n') out.push_back(' ');
        } else {
            out.push_back(c);
        }
    }
    return text::truncate_utf8(text::sanitize_utf8(text::trim(out)), max_chars);
}

std::string extract_meta_tag(std::string_view html, std::string_view attr_needle) {
    const std::string folded_html = text::fold(html);
    const std::string folded_needle = text::fold(attr_needle);
    const auto pos = folded_html.find(folded_needle);
    if (pos == std::string::npos) return {};
    const auto tag_end = folded_html.find('>', pos);
    if (tag_end == std::string::npos) return {};
    const std::string_view tag_slice = html.substr(pos, tag_end - pos);
    const std::string folded_slice = folded_html.substr(pos, tag_end - pos);
    const auto content_pos = folded_slice.find("content=");
    if (content_pos == std::string::npos) return {};
    std::size_t val_start = content_pos + 8;
    if (val_start >= tag_slice.size()) return {};
    const char quote = tag_slice[val_start];
    if (quote == '"' || quote == '\'') {
        ++val_start;
        const auto val_end = tag_slice.find(quote, val_start);
        if (val_end != std::string_view::npos) {
            return text::trim(tag_slice.substr(val_start, val_end - val_start));
        }
    }
    return {};
}

std::string fetch_website_summary(std::string_view url_str) {
    const ParsedUrl pu = parse_url(std::string(url_str));
    if (!pu.ok) return {};
    const std::string html = http_get_string(
        win::widen(pu.host),
        pu.port,
        pu.secure,
        win::widen(pu.path.empty() ? "/" : pu.path),
        L"Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\r\n",
        3200,
        96000);
    if (html.empty()) return {};

    std::string out;
    // Extract <title>
    const std::string fhtml = text::fold(html);
    const auto t1 = fhtml.find("<title>");
    const auto t2 = fhtml.find("</title>");
    if (t1 != std::string::npos && t2 != std::string::npos && t2 > t1 + 7) {
        const std::string title = text::trim(html.substr(t1 + 7, t2 - (t1 + 7)));
        if (!title.empty()) out += "• Official site title: " + title + "\n";
    }
    const std::string desc = extract_meta_tag(html, "name=\"description\"");
    const std::string og_desc = extract_meta_tag(html, "property=\"og:description\"");
    if (!desc.empty()) out += "• Official description: " + desc + "\n";
    else if (!og_desc.empty()) out += "• Official description: " + og_desc + "\n";

    const std::string body_text = strip_html_to_text(html, 1800);
    if (!body_text.empty()) {
        out += "• Content extracted from " + std::string(url_str) + ":\n" + body_text + "\n";
    }
    return text::trim(out);
}

std::string search_ddg_lite(std::string_view query) {
    const std::string encoded = url_encode(text::truncate_utf8(text::trim(query), 160));
    const std::wstring path = win::widen("/html/?q=" + encoded);
    const std::string html = http_get_string(
        L"html.duckduckgo.com",
        INTERNET_DEFAULT_HTTPS_PORT,
        true,
        path,
        L"Accept-Language: pt-BR,pt;q=0.9,en;q=0.8\r\n",
        2600,
        64000);
    if (html.empty()) return {};
    std::string out;
    std::size_t pos = 0;
    int count = 0;
    while (count < 4 && (pos = html.find("result__snippet", pos)) != std::string::npos) {
        const auto gt = html.find('>', pos);
        const auto lt = html.find("</a>", gt != std::string::npos ? gt : pos);
        if (gt == std::string::npos || lt == std::string::npos || lt <= gt) break;
        std::string snippet = strip_html_to_text(std::string_view(html).substr(gt + 1, lt - gt - 1), 320);
        if (snippet.size() > 20) {
            out += "• " + snippet + "\n";
            ++count;
        }
        pos = lt + 4;
    }
    return text::trim(out);
}

void infer_company_and_role(std::string_view summary, std::string& company_out, std::string& role_out) {
    const std::string s = text::trim(summary);
    if (s.empty()) return;
    // Common patterns: "Entrevista Técnica - Nubank", "Interview @ Stripe (Senior SWE)", "Itaú | Engenheiro de Software"
    for (std::string_view sep : {" - ", " | ", " @ ", " – ", ": "}) {
        const auto pos = s.find(sep);
        if (pos != std::string::npos) {
            const std::string left = text::trim(s.substr(0, pos));
            const std::string right = text::trim(s.substr(pos + sep.size()));
            const std::string fl = text::fold(left);
            if (fl.find("entrevista") != std::string::npos || fl.find("interview") != std::string::npos ||
                fl.find("bate-papo") != std::string::npos || fl.find("chat") != std::string::npos ||
                fl.find("case") != std::string::npos || fl.find("tecnic") != std::string::npos) {
                company_out = right;
                role_out = left;
            } else {
                company_out = left;
                role_out = right;
            }
            return;
        }
    }
}

std::string unescape_ics_text(std::string_view raw) {
    std::string out;
    out.reserve(raw.size());
    for (std::size_t i = 0; i < raw.size(); ++i) {
        if (raw[i] == '\\' && i + 1 < raw.size()) {
            const char next = raw[++i];
            if (next == 'n' || next == 'N') out.push_back('\n');
            else if (next == ',' || next == ';' || next == '\\') out.push_back(next);
            else out.push_back(next);
        } else {
            out.push_back(raw[i]);
        }
    }
    return text::trim(out);
}

std::string format_ics_datetime(std::string_view raw) {
    // e.g. 20261022T143000Z or 20261022
    std::string digits;
    for (char c : raw) {
        if (std::isdigit(static_cast<unsigned char>(c)) || c == 'T') digits.push_back(c);
    }
    if (digits.size() >= 8) {
        const std::string dd = digits.substr(6, 2);
        const std::string mm = digits.substr(4, 2);
        const std::string yyyy = digits.substr(0, 4);
        if (digits.size() >= 13 && digits[8] == 'T') {
            const std::string hh = digits.substr(9, 2);
            const std::string min = digits.substr(11, 2);
            return dd + "/" + mm + "/" + yyyy + " " + hh + ":" + min;
        }
        return dd + "/" + mm + "/" + yyyy;
    }
    return std::string(raw);
}

} // namespace

std::string search(std::string_view query) {
    const std::string trimmed = text::trim(query);
    if (trimmed.size() < 3) return {};

    const std::wstring host = L"api.duckduckgo.com";
    const std::wstring path = win::widen(
        "/?q=" + url_encode(text::truncate_utf8(trimmed, 240)) +
        "&format=json&no_html=1&skip_disambig=1");
    const std::string body = http_get_string(host, INTERNET_DEFAULT_HTTPS_PORT, true, path, {}, 1600, 16000);
    if (body.empty()) return {};
    auto parsed = json::Parser::parse(body);
    if (!parsed || !parsed->is_object()) return {};

    std::string result;
    const std::string abstract = (*parsed)["AbstractText"].as_string();
    const std::string abstract_url = (*parsed)["AbstractURL"].as_string();
    if (!abstract.empty()) {
        result = abstract;
        if (!abstract_url.empty()) result += " (" + abstract_url + ")";
        result.push_back('\n');
    }
    const auto& topics = (*parsed)["RelatedTopics"];
    for (std::size_t i = 0; i < topics.size() && result.size() < 4000; ++i) {
        append_topic_text(topics.at(i), result);
    }
    return text::truncate_utf8(result, 4000);
}

std::string search_company(std::string_view company, std::string_view role) {
    const std::string comp = text::trim(company);
    const std::string rl = text::trim(role);
    if (comp.empty()) return {};

    std::string target_url;
    std::string brand_name = comp;
    const bool is_url = looks_like_url_or_domain(comp, target_url, brand_name);

    auto fut_site = std::async(std::launch::async, [is_url, target_url]() -> std::string {
        if (!is_url || target_url.empty()) return {};
        return fetch_website_summary(target_url);
    });
    auto fut_ddg_html = std::async(std::launch::async, [brand_name, comp, is_url]() {
        const std::string q = is_url ? (brand_name + " " + comp) : (comp + " empresa produto tecnologia");
        return search_ddg_lite(q);
    });
    auto fut_wiki_pt = std::async(std::launch::async, [brand_name]() {
        return query_wikipedia_extract(L"pt.wikipedia.org", brand_name);
    });
    auto fut_wiki_en = std::async(std::launch::async, [brand_name]() {
        return query_wikipedia_extract(L"en.wikipedia.org", brand_name);
    });
    auto fut_ddg = std::async(std::launch::async, [brand_name]() {
        return search(brand_name);
    });

    const std::string site_info = fut_site.get();
    const std::string ddg_html = fut_ddg_html.get();
    const std::string wiki_pt = fut_wiki_pt.get();
    const std::string wiki_en = fut_wiki_en.get();
    const std::string ddg = fut_ddg.get();

    std::string out;
    out += "Empresa: " + brand_name + (is_url ? " (" + target_url + ")" : "") +
           (rl.empty() ? "" : " | Cargo: " + rl) + "\n\n";
    out += "[Company context & business]\n";
    if (!site_info.empty()) {
        out += site_info + "\n";
    }
    if (!ddg_html.empty()) {
        out += ddg_html + "\n";
    }
    if (!wiki_pt.empty()) {
        out += wiki_pt + "\n";
    }
    if (!ddg.empty()) {
        out += ddg + "\n";
    } else if (!wiki_en.empty()) {
        out += wiki_en + "\n";
    }
    if (site_info.empty() && ddg_html.empty() && wiki_pt.empty() && wiki_en.empty() && ddg.empty()) {
        out += "• No public information was found about " + brand_name + ": research it before the interview.\n";
    }

    out += "\n[Culture-fit pillars & how to answer for " + brand_name + "]\n";
    out += "• Customer focus & business impact: connect technical decisions (architecture, performance, reliability) to real metrics from your projects that matter to " + brand_name + ".\n";
    out += "• Ownership: show end-to-end ownership, citing only real facts from your resume and the projects attached in the RAG.\n";
    out += "• Data-driven decisions: structure behavioral answers with STAR without inventing numbers or experiences.\n";

    return text::truncate_utf8(text::trim(out), 4200);
}

std::vector<CalendarEvent> parse_ics_events(std::string_view ics_body, std::size_t max_events) {
    // Unfold RFC 5545 folded lines (CRLF followed by space or tab)
    std::string unfolded;
    unfolded.reserve(ics_body.size());
    for (std::size_t i = 0; i < ics_body.size(); ++i) {
        if (ics_body[i] == '\r') continue;
        if (ics_body[i] == '\n' && i + 1 < ics_body.size() &&
            (ics_body[i + 1] == ' ' || ics_body[i + 1] == '\t')) {
            ++i; // skip newline and folding whitespace
            continue;
        }
        unfolded.push_back(ics_body[i]);
    }

    std::vector<CalendarEvent> events;
    bool in_event = false;
    CalendarEvent cur;
    std::string raw_dtstart;
    struct SortableEvent {
        std::string sort_key;
        CalendarEvent ev;
    };
    std::vector<SortableEvent> collected;

    std::size_t start = 0;
    while (start <= unfolded.size()) {
        std::size_t end = unfolded.find('\n', start);
        if (end == std::string::npos) end = unfolded.size();
        std::string_view line(unfolded.data() + start, end - start);
        start = end + 1;

        line = text::trim(line);
        if (line.empty()) continue;

        if (line == "BEGIN:VEVENT") {
            in_event = true;
            cur = CalendarEvent{};
            raw_dtstart.clear();
            continue;
        }
        if (line == "END:VEVENT") {
            if (in_event && !cur.title.empty()) {
                infer_company_and_role(cur.title, cur.company_hint, cur.role_hint);
                collected.push_back(SortableEvent{raw_dtstart, std::move(cur)});
            }
            in_event = false;
            continue;
        }
        if (!in_event) continue;

        const auto colon = line.find(':');
        if (colon == std::string_view::npos) continue;
        std::string_view prop = line.substr(0, colon);
        std::string_view val = line.substr(colon + 1);
        const auto semi = prop.find(';');
        const std::string_view key = semi == std::string_view::npos ? prop : prop.substr(0, semi);

        if (key == "SUMMARY") {
            cur.title = unescape_ics_text(val);
        } else if (key == "DTSTART") {
            raw_dtstart = std::string(val);
            cur.start_time = format_ics_datetime(val);
        } else if (key == "DESCRIPTION") {
            cur.description = text::truncate_utf8(unescape_ics_text(val), 800);
        } else if (key == "LOCATION") {
            cur.location = unescape_ics_text(val);
        }
    }

    // Keep the most recent / upcoming events (sorted descending by start timestamp, then reversed so chronological)
    std::sort(collected.begin(), collected.end(),
              [](const SortableEvent& a, const SortableEvent& b) { return a.sort_key > b.sort_key; });
    if (collected.size() > max_events) collected.resize(max_events);
    std::reverse(collected.begin(), collected.end());

    events.reserve(collected.size());
    for (auto& item : collected) {
        events.push_back(std::move(item.ev));
    }
    return events;
}

std::vector<CalendarEvent> fetch_google_calendar_events(std::string_view url_or_token,
                                                        std::string* error_out) {
    const std::string input = text::trim(url_or_token);
    if (input.empty()) {
        if (error_out) *error_out = "Enter the private Google Calendar .ics URL or an OAuth2 token.";
        return {};
    }

    // Case 1: HTTP/HTTPS URL (e.g. Google Calendar Secret Address in iCal .ics format)
    if (input.rfind("http://", 0) == 0 || input.rfind("https://", 0) == 0 || input.rfind("webcal://", 0) == 0) {
        std::string normalized = input;
        if (normalized.rfind("webcal://", 0) == 0) {
            normalized = "https://" + normalized.substr(9);
        }
        const ParsedUrl u = parse_url(normalized);
        if (!u.ok) {
            if (error_out) *error_out = "Invalid Google Calendar URL.";
            return {};
        }
        const std::string body = http_get_string(win::widen(u.host), static_cast<INTERNET_PORT>(u.port),
                                                 u.secure, win::widen(u.path), {}, 3500, 256000);
        if (body.empty()) {
            if (error_out) *error_out = "Could not download the Google Calendar schedule (check the .ics link).";
            return {};
        }
        auto evs = parse_ics_events(body, 15);
        if (evs.empty() && error_out) {
            *error_out = "Connected, but no events were found in the calendar.";
        }
        return evs;
    }

    // Case 2: Google Calendar REST API v3 OAuth2 Bearer Token
    SYSTEMTIME st{};
    GetSystemTime(&st);
    char iso[64];
    std::snprintf(iso, sizeof(iso), "%04u-%02u-%02uT00:00:00Z", st.wYear, st.wMonth, st.wDay);
    const std::wstring path = win::widen(
        std::string("/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=15&timeMin=") +
        url_encode(iso));
    const std::wstring auth = L"Authorization: Bearer " + win::widen(input) + L"\r\n";
    const std::string body = http_get_string(L"www.googleapis.com", INTERNET_DEFAULT_HTTPS_PORT, true,
                                             path, auth, 3000, 128000);
    if (body.empty()) {
        if (error_out) *error_out = "Google Calendar OAuth2 token rejected or expired.";
        return {};
    }
    auto parsed = json::Parser::parse(body);
    if (!parsed || !parsed->is_object()) {
        if (error_out) *error_out = "Invalid response from the Google Calendar API.";
        return {};
    }
    const auto& items = (*parsed)["items"];
    std::vector<CalendarEvent> out;
    if (items.is_array()) {
        for (std::size_t i = 0; i < items.size(); ++i) {
            const auto& it = items.at(i);
            if (!it.is_object()) continue;
            CalendarEvent ev;
            ev.title = it["summary"].as_string();
            if (ev.title.empty()) continue;
            std::string dt = it["start"]["dateTime"].as_string();
            if (dt.empty()) dt = it["start"]["date"].as_string();
            ev.start_time = dt.size() >= 16 ? dt.substr(8, 2) + "/" + dt.substr(5, 2) + " " + dt.substr(11, 5) : dt;
            ev.description = text::truncate_utf8(it["description"].as_string(), 800);
            ev.location = it["hangoutLink"].as_string();
            if (ev.location.empty()) ev.location = it["location"].as_string();
            infer_company_and_role(ev.title, ev.company_hint, ev.role_hint);
            out.push_back(std::move(ev));
        }
    }
    return out;
}

} // namespace rtai::web
