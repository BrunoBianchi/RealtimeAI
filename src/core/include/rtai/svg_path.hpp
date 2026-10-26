// Pure core: SVG path-data parser ("M12 2a3 3 0 0 0-3 3v7Z" ...).
// Produces absolute, normalized commands (H/V -> line, S -> cubic,
// T -> quadratic) that map 1:1 onto Direct2D geometry sinks, whose
// D2D1_ARC_SEGMENT has exactly the SVG arc semantics.
#pragma once

#include <cctype>
#include <cmath>
#include <algorithm>
#include <cstdlib>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace rtai::svg {

struct Pt {
    float x{0}, y{0};
};

struct Cmd {
    enum class Kind { Move, Line, Cubic, Quad, Arc, Close } kind{Kind::Move};
    Pt p;            // end point (Move/Line/Cubic/Quad/Arc)
    Pt c1, c2;       // control points (Cubic: c1,c2; Quad: c1)
    float rx{0}, ry{0}, rotation{0};
    bool large_arc{false}, sweep{false}; // sweep=true: clockwise (y down)
};

class PathParser {
public:
    explicit PathParser(std::string_view d) : s_(d) {}

    // nullopt on malformed input.
    std::optional<std::vector<Cmd>> parse() {
        std::vector<Cmd> out;
        char cmd = 0;
        Pt cur, start, last_ctrl;
        char prev = 0;
        for (;;) {
            skip_ws();
            if (i_ >= s_.size()) break;
            const char c = s_[i_];
            if (std::isalpha(static_cast<unsigned char>(c))) {
                cmd = c;
                ++i_;
            } else if (cmd == 0) {
                return std::nullopt;
            } else if (cmd == 'M') {
                cmd = 'L'; // implicit lineto after moveto
            } else if (cmd == 'm') {
                cmd = 'l';
            } else if (cmd == 'Z' || cmd == 'z') {
                return std::nullopt; // numbers after Z
            }
            const bool rel = std::islower(static_cast<unsigned char>(cmd)) != 0;
            const char up = static_cast<char>(std::toupper(static_cast<unsigned char>(cmd)));
            Cmd k;
            auto absx = [&](float v) { return rel ? cur.x + v : v; };
            auto absy = [&](float v) { return rel ? cur.y + v : v; };
            switch (up) {
                case 'M': {
                    float x, y;
                    if (!num(x) || !num(y)) return std::nullopt;
                    k.kind = Cmd::Kind::Move;
                    k.p = {absx(x), absy(y)};
                    start = k.p;
                    break;
                }
                case 'L': {
                    float x, y;
                    if (!num(x) || !num(y)) return std::nullopt;
                    k.kind = Cmd::Kind::Line;
                    k.p = {absx(x), absy(y)};
                    break;
                }
                case 'H': {
                    float x;
                    if (!num(x)) return std::nullopt;
                    k.kind = Cmd::Kind::Line;
                    k.p = {absx(x), cur.y};
                    break;
                }
                case 'V': {
                    float y;
                    if (!num(y)) return std::nullopt;
                    k.kind = Cmd::Kind::Line;
                    k.p = {cur.x, absy(y)};
                    break;
                }
                case 'C': {
                    float v[6];
                    for (float& f : v) if (!num(f)) return std::nullopt;
                    k.kind = Cmd::Kind::Cubic;
                    k.c1 = {absx(v[0]), absy(v[1])};
                    k.c2 = {absx(v[2]), absy(v[3])};
                    k.p = {absx(v[4]), absy(v[5])};
                    break;
                }
                case 'S': {
                    float v[4];
                    for (float& f : v) if (!num(f)) return std::nullopt;
                    k.kind = Cmd::Kind::Cubic;
                    const bool prev_cubic = prev == 'C' || prev == 'S';
                    k.c1 = prev_cubic ? Pt{2 * cur.x - last_ctrl.x, 2 * cur.y - last_ctrl.y} : cur;
                    k.c2 = {absx(v[0]), absy(v[1])};
                    k.p = {absx(v[2]), absy(v[3])};
                    break;
                }
                case 'Q': {
                    float v[4];
                    for (float& f : v) if (!num(f)) return std::nullopt;
                    k.kind = Cmd::Kind::Quad;
                    k.c1 = {absx(v[0]), absy(v[1])};
                    k.p = {absx(v[2]), absy(v[3])};
                    break;
                }
                case 'T': {
                    float x, y;
                    if (!num(x) || !num(y)) return std::nullopt;
                    k.kind = Cmd::Kind::Quad;
                    const bool prev_quad = prev == 'Q' || prev == 'T';
                    k.c1 = prev_quad ? Pt{2 * cur.x - last_ctrl.x, 2 * cur.y - last_ctrl.y} : cur;
                    k.p = {absx(x), absy(y)};
                    break;
                }
                case 'A': {
                    float rx, ry, rot, x, y;
                    bool large, sweep;
                    if (!num(rx) || !num(ry) || !num(rot) || !flag(large) || !flag(sweep) || !num(x) ||
                        !num(y)) {
                        return std::nullopt;
                    }
                    k.kind = Cmd::Kind::Arc;
                    k.rx = std::fabs(rx);
                    k.ry = std::fabs(ry);
                    k.rotation = rot;
                    k.large_arc = large;
                    k.sweep = sweep;
                    k.p = {absx(x), absy(y)};
                    break;
                }
                case 'Z':
                    k.kind = Cmd::Kind::Close;
                    k.p = start;
                    break;
                default:
                    return std::nullopt;
            }
            if (k.kind == Cmd::Kind::Cubic) last_ctrl = k.c2;
            else if (k.kind == Cmd::Kind::Quad) last_ctrl = k.c1;
            cur = k.p;
            prev = up;
            out.push_back(k);
        }
        if (!out.empty() && out.front().kind != Cmd::Kind::Move) return std::nullopt;
        return out;
    }

private:
    void skip_ws() {
        while (i_ < s_.size() && (std::isspace(static_cast<unsigned char>(s_[i_])) || s_[i_] == ',')) ++i_;
    }

    bool num(float& out) {
        skip_ws();
        if (i_ >= s_.size()) return false;
        std::size_t j = i_;
        if (s_[j] == '+' || s_[j] == '-') ++j;
        bool digits = false, dot = false;
        while (j < s_.size()) {
            const char c = s_[j];
            if (std::isdigit(static_cast<unsigned char>(c))) {
                digits = true;
                ++j;
            } else if (c == '.' && !dot) {
                dot = true;
                ++j;
            } else {
                break;
            }
        }
        if (!digits) return false;
        if (j < s_.size() && (s_[j] == 'e' || s_[j] == 'E')) {
            std::size_t k = j + 1;
            if (k < s_.size() && (s_[k] == '+' || s_[k] == '-')) ++k;
            if (k < s_.size() && std::isdigit(static_cast<unsigned char>(s_[k]))) {
                while (k < s_.size() && std::isdigit(static_cast<unsigned char>(s_[k]))) ++k;
                j = k;
            }
        }
        out = std::strtof(std::string(s_.substr(i_, j - i_)).c_str(), nullptr);
        i_ = j;
        return true;
    }

    // Arc flags are single characters and may be written without separators
    // ("a1 1 0 011 1").
    bool flag(bool& out) {
        skip_ws();
        if (i_ >= s_.size() || (s_[i_] != '0' && s_[i_] != '1')) return false;
        out = s_[i_] == '1';
        ++i_;
        return true;
    }

    std::string_view s_;
    std::size_t i_{0};
};

inline std::optional<std::vector<Cmd>> parse_path(std::string_view d) { return PathParser(d).parse(); }

// Cubic Bezier segments approximating an SVG elliptical arc that starts at
// `from` (SVG 1.1 F.6.5 endpoint -> center conversion, <= 90 deg per piece).
// Renderers then never depend on native arc support.
struct CubicSeg {
    Pt c1, c2, p;
};

inline std::vector<CubicSeg> arc_to_cubics(Pt from, const Cmd& a) {
    constexpr double kPi = 3.14159265358979323846;
    std::vector<CubicSeg> out;
    double rx = std::fabs(a.rx), ry = std::fabs(a.ry);
    if ((from.x == a.p.x && from.y == a.p.y)) return out;
    if (rx < 1e-9 || ry < 1e-9) {
        out.push_back({from, a.p, a.p}); // degenerate: straight line
        return out;
    }
    const double phi = a.rotation * kPi / 180.0;
    const double c = std::cos(phi), s = std::sin(phi);
    const double dx2 = (from.x - a.p.x) / 2.0, dy2 = (from.y - a.p.y) / 2.0;
    const double x1p = c * dx2 + s * dy2;
    const double y1p = -s * dx2 + c * dy2;
    const double lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1.0) {
        rx *= std::sqrt(lambda);
        ry *= std::sqrt(lambda);
    }
    const double num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const double den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    double coef = den > 0 ? std::sqrt(std::max(0.0, num / den)) : 0.0;
    if (a.large_arc == a.sweep) coef = -coef;
    const double cxp = coef * rx * y1p / ry;
    const double cyp = -coef * ry * x1p / rx;
    const double cx = c * cxp - s * cyp + (from.x + a.p.x) / 2.0;
    const double cy = s * cxp + c * cyp + (from.y + a.p.y) / 2.0;
    auto angle = [](double ux, double uy, double vx, double vy) {
        return std::atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    };
    const double ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
    const double vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
    const double theta1 = angle(1.0, 0.0, ux, uy);
    double dtheta = angle(ux, uy, vx, vy);
    if (!a.sweep && dtheta > 0) dtheta -= 2 * kPi;
    if (a.sweep && dtheta < 0) dtheta += 2 * kPi;
    const int n = std::max(1, static_cast<int>(std::ceil(std::fabs(dtheta) / (kPi / 2) - 1e-9)));
    const double delta = dtheta / n;
    const double t = 4.0 / 3.0 * std::tan(delta / 4.0);
    auto point = [&](double ang) {
        return Pt{static_cast<float>(cx + c * rx * std::cos(ang) - s * ry * std::sin(ang)),
                  static_cast<float>(cy + s * rx * std::cos(ang) + c * ry * std::sin(ang))};
    };
    auto deriv = [&](double ang) {
        return Pt{static_cast<float>(-c * rx * std::sin(ang) - s * ry * std::cos(ang)),
                  static_cast<float>(-s * rx * std::sin(ang) + c * ry * std::cos(ang))};
    };
    for (int i = 0; i < n; ++i) {
        const double a1 = theta1 + i * delta, a2 = a1 + delta;
        const Pt e1 = point(a1), e2 = point(a2), d1 = deriv(a1), d2 = deriv(a2);
        CubicSeg seg;
        seg.c1 = {e1.x + static_cast<float>(t) * d1.x, e1.y + static_cast<float>(t) * d1.y};
        seg.c2 = {e2.x - static_cast<float>(t) * d2.x, e2.y - static_cast<float>(t) * d2.y};
        seg.p = i + 1 == n ? a.p : e2; // land exactly on the endpoint
        out.push_back(seg);
    }
    return out;
}


} // namespace rtai::svg
