#include <gtest/gtest.h>

#include "rtai/json_min.hpp"

using namespace rtai::json;

TEST(JsonMin, ParsesObjectWithStringAndBool) {
    auto v = Parser::parse(R"({"type":"Results","is_final":true})");
    ASSERT_TRUE(v.has_value());
    ASSERT_TRUE(v->is_object());
    EXPECT_EQ((*v)["type"].as_string(), "Results");
    EXPECT_TRUE((*v)["is_final"].as_bool());
}

TEST(JsonMin, ParsesNestedArraysAndNumbers) {
    auto v = Parser::parse(R"({"channel":{"alternatives":[{"transcript":"hello","confidence":0.97}]}})");
    ASSERT_TRUE(v.has_value());
    const auto& alt = (*v)["channel"]["alternatives"].at(0);
    EXPECT_EQ(alt["transcript"].as_string(), "hello");
    EXPECT_NEAR(alt["confidence"].as_number(), 0.97, 1e-6);
}

TEST(JsonMin, HandlesEscapesAndUnicode) {
    auto v = Parser::parse(R"({"t":"line\nbreak \u00e9"})");
    ASSERT_TRUE(v.has_value());
    const std::string s = (*v)["t"].as_string();
    EXPECT_NE(s.find('\n'), std::string::npos);
    // \u00e9 => 'é' in UTF-8 is 0xC3 0xA9
    EXPECT_NE(s.find("\xC3\xA9"), std::string::npos);
}

TEST(JsonMin, RejectsTrailingGarbage) {
    EXPECT_FALSE(Parser::parse(R"({"a":1}xx)").has_value());
}

TEST(JsonMin, RejectsUnterminatedString) {
    EXPECT_FALSE(Parser::parse(R"({"a":"oops)").has_value());
}

TEST(JsonMin, MissingFieldReturnsNull) {
    auto v = Parser::parse(R"({"a":1})");
    ASSERT_TRUE(v.has_value());
    EXPECT_TRUE((*v)["missing"].is_null());
    EXPECT_EQ((*v)["missing"].as_string(), "");
}

TEST(JsonMin, CombinesSurrogatePairsIntoUtf8) {
    auto v = Parser::parse(R"({"t":"ok 😀"})");
    ASSERT_TRUE(v.has_value());
    EXPECT_EQ((*v)["t"].as_string(), "ok \xF0\x9F\x98\x80"); // U+1F600
}

TEST(JsonMin, LoneSurrogateBecomesReplacementChar) {
    auto v = Parser::parse(R"({"t":"\ud83d!"})");
    ASSERT_TRUE(v.has_value());
    EXPECT_EQ((*v)["t"].as_string(), "\xEF\xBF\xBD!");
}

TEST(JsonWriter, WritesNestedStructuresWithEscapes) {
    Writer w;
    w.begin_object()
        .field("type", "turn")
        .field_int("t", 1234)
        .field_bool("final", true)
        .field_double("conf", 0.5, 2)
        .key("text").string_value("diz \"oi\"\nvoc\xC3\xAA")
        .key("list").begin_array().int_value(1).string_value("a").null_value().end_array()
        .end_object();
    EXPECT_EQ(w.str(),
              R"({"type":"turn","t":1234,"final":true,"conf":0.50,"text":"diz \"oi\"\nvoc)"
              "\xC3\xAA"
              R"(","list":[1,"a",null]})");
    // Round trip through the parser.
    auto v = Parser::parse(w.str());
    ASSERT_TRUE(v.has_value());
    EXPECT_EQ((*v)["text"].as_string(), "diz \"oi\"\nvoc\xC3\xAA");
    EXPECT_EQ((*v)["list"].size(), 3u);
}

TEST(JsonWriter, EscapesControlCharacters) {
    EXPECT_EQ(quote(std::string("a\x01" "b", 3)), R"("a\u0001b")");
}

TEST(JsonMin, RejectsExcessiveNesting) {
    std::string deep(200, '[');
    deep += std::string(200, ']');
    EXPECT_FALSE(Parser::parse(deep).has_value());
}
