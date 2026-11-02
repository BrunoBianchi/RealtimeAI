// Repairs cp1252 double-encoding ("mojibake") found in agent data written by
// older builds: UTF-8 text that was decoded as Windows-1252 and re-encoded as
// UTF-8 ("AÃ§Ã£o" instead of "Ação"). The detector must be conservative:
// legitimate accented text must pass through untouched.
#include <gtest/gtest.h>

#include "rtai/text_util.hpp"
#include "rtai/mini_agent.hpp"

using namespace rtai;

namespace {
// "Nubank Â· EstÃ¡gio em Engenharia de Software" exactly as found on disk
// (UTF-8 bytes of the double-encoded form).
const char* kCorruptedName = "Nubank \xC3\x82\xC2\xB7 Est\xC3\x83\xC2\xA1gio em Engenharia de Software";
const char* kCleanName = "Nubank \xC2\xB7 Est\xC3\xA1gio em Engenharia de Software";  // "Nubank · Estágio ..."
}  // namespace

TEST(RepairMojibake, RepairsRealDoubleEncodedAgentName) {
    const auto fixed = text::repair_mojibake(kCorruptedName);
    ASSERT_TRUE(fixed.has_value());
    EXPECT_EQ(*fixed, std::string(kCleanName));
}

TEST(RepairMojibake, RepairsActionWordAndMiddleDot) {
    // "AÃ§Ã£o" (double-encoded "Ação")
    const auto fixed = text::repair_mojibake("A\xC3\x83\xC2\xA7\xC3\x83\xC2\xA3o");
    ASSERT_TRUE(fixed.has_value());
    EXPECT_EQ(*fixed, std::string("A\xC3\xA7\xC3\xA3o"));
}

TEST(RepairMojibake, RepairsEmDashMojibake) {
    // "\xE2\x80\x94" as UTF-8 is the CLEAN em dash "\u2014". Double-encoded,
    // each byte becomes a cp1252 char: 0xE2->"\u00E2", 0x80->"\u20AC",
    // 0x94->"\u201D" ("\xC3\xA2 \xE2\x82\xAC \xE2\x80\x9D" in UTF-8).
    // "fundo â€” precisa" (corrupted) must repair to "fundo — precisa".
    const auto fixed = text::repair_mojibake("fundo \xC3\xA2\xE2\x82\xAC\xE2\x80\x9D precisa");
    ASSERT_TRUE(fixed.has_value());
    EXPECT_EQ(*fixed, std::string("fundo \xE2\x80\x94 precisa"));
    // The clean em dash must pass through untouched.
    EXPECT_FALSE(text::repair_mojibake("fundo \xE2\x80\x94 precisa querer").has_value());
}

TEST(RepairMojibake, LeavesCleanAccentedTextUntouched) {
    // Real Portuguese, already correct: "Você não precisa saber tudo".
    const std::string clean = "Voc\xC3\xAA n\xC3\xA3o precisa saber tudo";
    EXPECT_FALSE(text::repair_mojibake(clean).has_value());
}

TEST(RepairMojibake, LeavesCleanMiddleDotAndCedillaUntouched) {
    const std::string clean = "Tech Lead \xC2\xB7 Java & Arquitetura, Situa\xC3\xA7\xC3\xA3o";
    EXPECT_FALSE(text::repair_mojibake(clean).has_value());
}

TEST(RepairMojibake, LeavesPureAsciiUntouched) {
    EXPECT_FALSE(text::repair_mojibake("Backend Pleno - Go").has_value());
    EXPECT_FALSE(text::repair_mojibake("").has_value());
}

TEST(RepairMojibake, LeavesNonLatinTextUntouched) {
    // Legitimate Greek ("Ελληνικά") and Cyrillic ("Привет") are not cp1252
    // mojibake and must never be rewritten.
    EXPECT_FALSE(text::repair_mojibake("\xCE\x95\xCE\xBB\xCE\xBB\xCE\xB7\xCE\xBD\xCE\xB9\xCE\xBA\xCE\xAC").has_value());
    EXPECT_FALSE(text::repair_mojibake("\xD0\x9F\xD1\x80\xCE\xB8\xD0\xB2\xD0\xB5\xD1\x82").has_value());
}

TEST(RepairMojibake, MixedAsciiAndMojibakeRepairsOnlyMojibakePart) {
    const auto fixed = text::repair_mojibake("Est\xC3\x83\xC2\xA1gio - Backend Pleno");
    ASSERT_TRUE(fixed.has_value());
    EXPECT_EQ(*fixed, std::string("Est\xC3\xA1gio - Backend Pleno"));
}

TEST(RepairMojibake, AgentFromJsonSelfHealsCorruptedFields) {
    // A minimal agent JSON with the exact corrupted name found on disk.
    const std::string raw = std::string("{") +
        "\"id\":\"hiring-manager-interview\","
        "\"name\":\"" + kCorruptedName + "\","
        "\"company\":\"Nubank\","
        "\"role\":\"Est\\u00e1gio\","
        "\"custom_instructions\":\"Use o formato STAR (Contexto, A\xC3\x83\xC2\xA7\xC3\x83\xC2\xA3o, Resultado)\"}";
    const auto p = MiniAgentProfile::from_json(raw);
    ASSERT_TRUE(p.has_value());
    EXPECT_EQ(p->name, std::string(kCleanName));
    EXPECT_EQ(p->custom_instructions,
              std::string("Use o formato STAR (Contexto, A\xC3\xA7\xC3\xA3o, Resultado)"));
    // Clean fields stay clean.
    EXPECT_EQ(p->company, std::string("Nubank"));
    EXPECT_EQ(p->role, std::string("Est\xC3\xA1gio"));
}

TEST(RepairMojibake, AgentFromJsonSelfHealsDocumentsAndGoalMemory) {
    // Documents and goal_memory are parsed AFTER the scalar fields; the heal
    // for them must run at the end of from_json (regression: it used to run
    // before the vectors were filled, healing nothing).
    const std::string raw = std::string("{") +
        "\"id\":\"x\",\"name\":\"Ok\","
        "\"goal_memory\":{\"strengths\":[\"Boa comunica\\u00e7\\u00e3o\"],"
        "\"improve\":[\"Perguntas t\\u00e9cnicas\"]},"
        "\"documents\":[{\"name\":\"cv.md\",\"content\":\"Conte\\u00c3\\u00bado do CV\"}]}";
    const auto p = MiniAgentProfile::from_json(raw);
    ASSERT_TRUE(p.has_value());
    ASSERT_EQ(p->documents.size(), 1u);
    EXPECT_EQ(p->documents[0].content, std::string("Conte\xC3\xBA" "do do CV"));
    ASSERT_EQ(p->goal_memory_strengths.size(), 1u);
    EXPECT_EQ(p->goal_memory_strengths[0], std::string("Boa comunica\xC3\xA7\xC3\xA3" "o"));
    ASSERT_EQ(p->goal_memory_improve.size(), 1u);
    EXPECT_EQ(p->goal_memory_improve[0], std::string("Perguntas t\xC3\xA9" "cnicas"));
}

TEST(RepairMojibake, AgentFromJsonLeavesCleanAgentUntouched) {
    const std::string raw = std::string("{") +
        "\"id\":\"itau\",\"name\":\"Analista de Dados Sr.\","
        "\"company\":\"Ita\\u00fa\",\"role\":\"Dados\"}";
    const auto p = MiniAgentProfile::from_json(raw);
    ASSERT_TRUE(p.has_value());
    EXPECT_EQ(p->name, std::string("Analista de Dados Sr."));
    EXPECT_EQ(p->company, std::string("Ita\xC3\xBA"));
}
