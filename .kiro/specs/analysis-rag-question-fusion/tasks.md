# Implementation Plan

## Overview

Fix the two chained defects (Symptom A — multi-clause subject truncation on the speculative path; Symptom B — RAG misgrounding between target-company and candidate-project), plus the correlated Req 2.5 (invalid Mini-Compact model id + silent fallback). All new logic lives in header-only pure units under `src/core/include/rtai/`, validated by seeded `std::mt19937` GoogleTest property-based tests (matching `tests/core_tests/test_fast_filter_properties.cpp`).

The workflow is exploratory: write the bug-condition exploration test and the preservation tests BEFORE the fix, confirm the exploration test FAILS and the preservation tests PASS on the unfixed code, then implement the fix and re-run the same tests.

---

## Tasks

- [x] 1. Write bug condition exploration test (BEFORE implementing the fix)
  - **Property 1: Bug Condition** - Subject fusion and candidate-project grounding at the generation trigger
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails** — document the counterexamples instead
  - **NOTE**: This test encodes the expected behavior; it becomes the fix validator in task 4.2 once it passes
  - **GOAL**: Surface counterexamples that demonstrate both symptoms of `isBugCondition(X)` (see design "Bug Condition")
  - Create `tests/core_tests/test_subject_fusion_properties.cpp` and `tests/core_tests/test_rag_grounding_properties.cpp`, registered in `tests/core_tests/CMakeLists.txt`
  - **Scoped PBT approach (deterministic reproducibility)**: seed `std::mt19937` with a fixed seed; scope generated inputs to the concrete failing families below
  - **Symptom A (`multiClauseSplit`)** — build two consecutive [Outros]/Loopback turns: prev = subject-bearing "Pensando agora na competição em que desenvolveu o Tech Finance" (closed), curr = "como você decidiu o que fazer primeiro?", gap ≈ 600 ms (< FUSION_WINDOW_MS). On UNFIXED code, assert the speculative-path trigger does NOT contain the subject ("Tech Finance") — proving the subject is lost before enrichment (ref design examples A1, Root Cause 1 & 2)
  - **Fragile-heuristic counterexample** — assert a non-subject text like "o time economizou tempo no onboarding" is treated as subject-bearing today via the `find("no ")` substring false-match (ref design example A, Root Cause 2)
  - **Symptom B (`projectMisground`)** — build a `MiniAgentProfile` with candidate-project documents (TechFinance, Midea PoC Speech-to-Text na UNIFEI) plus a target-company dossier (Tako / `mini_compact`). For a query that cites the project but arrives truncated (e.g. the 2nd clause only, or "me conta como foi"), assert `decide_rag_for_query` returns chunks anchored on the target company and NOT the cited project's chunks (ref design examples B1, Root Cause 3 & 4)
  - **Boundary (out of range)** — gap ≈ 8000 ms (> FUSION_WINDOW_MS): assert no fusion occurs (confirms the window limit)
  - Run both test files on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct — it proves the bug exists)
  - Document the counterexamples found (speculative trigger missing "Tech Finance"; target-company chunks returned for a candidate-project question; substring false-match) to confirm the root-cause analysis
  - Mark complete when the tests are written, run, and the failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _Validates: Property 1 (Bug Condition)_

- [x] 2. Write preservation property tests (BEFORE implementing the fix)
  - **Property 2: Preservation** - Non-buggy inputs unchanged
  - **IMPORTANT**: Follow the observation-first methodology — run the UNFIXED code first, record actual outputs, then assert those observed outputs across the input domain
  - Add preservation properties to `test_subject_fusion_properties.cpp` and `test_rag_grounding_properties.cpp`; extend coverage where helpful
  - **Observe (A — single clause / no subject)**: prev absent OR prev = non-subject small-talk ("Beleza.", "Tudo bem?") → record that the trigger equals `curr` byte-for-byte on unfixed code; write a property: for all non-subject-bearing prev (or gap > window), the enriched trigger equals `curr` unchanged (ref design Test Cases, Preservation 1; Req 3.1)
  - **Observe (A — stitching)**: two same-lane turns with gap < 1200 ms are stitched by `TurnAssembler::close()` today → write a property asserting the stitching output is unchanged (ref Preservation 2; Req 3.2)
  - **Observe (B — no project cited)**: for a fixed corpus and queries with no candidate-project term (e.g. "qual o prazo de implantação?"), record `decide_rag_for_query` output (needed, reason, chunk set) on unfixed code → write a property asserting the fixed decision equals the original for all such queries (ref example B2, Preservation 3; Req 3.3)
  - **Observe (triggers / Pin-on-Speak)**: add cases where subject fusion could interfere with `DecisionPolicy::evaluate` keyword/long-speech/upgrade and with Pin-on-Speak queueing, asserting they are untouched (ref Preservation 4; Req 3.4, 3.5)
  - Run the preservation tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (confirms the baseline behavior to preserve)
  - Mark complete when the tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - _Validates: Property 2 (Preservation)_

- [x] 3. Implement the fix

  - [x] 3.1 Add the pure subject-fusion units (header-only)
    - Create `src/core/include/rtai/subject_fusion.hpp` (keeps `turn_assembler.hpp` lean) with:
      - `bool is_subject_bearing(std::string_view text) noexcept` — fold the text and match anchor words as whole tokens (via `text::contains_word`/`starts_with_word`, NOT raw substring): "pensando", "pensa", "sobre", "projeto", "competicao", "passando", "falando", "considerando", plus topic prepositions ("no", "na", "em", "da", "do") only when followed by content and the turn is neither small-talk nor an already self-contained question. This fixes the `find("no ")` false-match
      - `struct FusionConfig { std::int64_t fusion_window_ms{6000}; };`
      - `std::string enrich_trigger_with_subject(std::optional<Turn> prev, std::string_view curr_text, std::int64_t gap_ms, const FusionConfig& cfg = {}) noexcept` — returns `text::join_space(prev->text, curr_text)` iff `prev && prev->source == AudioSource::Loopback && is_subject_bearing(prev->text) && gap_ms >= 0 && gap_ms < cfg.fusion_window_ms`; otherwise returns `std::string(curr_text)` exactly. This is the SINGLE source of the enriched trigger
    - _Bug_Condition: isBugCondition(X) — multiClauseSplit branch (design "Bug Condition")_
    - _Expected_Behavior: enrich_trigger_with_subject contains subjectOf(prev) AND curr_text (design "Fix Checking")_
    - _Preservation: returns curr unchanged when NOT subject-bearing / outside window (design Preservation Checking)_
    - _Requirements: 2.1, 2.2, 3.1_

  - [x] 3.2 Wire the enriched trigger into both engine paths
    - In `src/core/src/copilot_engine.cpp`, replace the inline "Context-Aware Trigger Resolution" block in `on_turn` (~565-595) with `enrich_trigger_with_subject(prev_loopback_turn, turn.text, gap)` where `gap = turn.start_ms - prev.end_ms`
    - In `enter_speculating(c)` (~676) and `on_speculative(c)` (~848), compute `enriched = enrich_trigger_with_subject(convo.last_from(AudioSource::Loopback), c.text, gap)` and pass `enriched` as the `trigger_text` to `build_copilot_messages` and into `meta`/`Shadow.speculative_text`, so speculative generation receives the subject
    - Keep the overlay-displayed text (the "shown"/`SpeculativeCandidateEvent`) as the LITERAL trigger utterance — only the LLM/RAG trigger is enriched
    - Keep speculative match/diverge coherent: compare the speculative text against the closed-turn text AFTER both pass through the same `enrich_trigger_with_subject`, so `SpeculativeMissEvent` semantics are preserved
    - _Bug_Condition: isBugCondition(X) — speculative path fires before enrichment (Root Cause 1)_
    - _Expected_Behavior: both paths call the same enrich_trigger_with_subject (design Property 1a)_
    - _Preservation: single-clause/non-subject turns unchanged; divergence still aborts (3.1, 3.6)_
    - _Requirements: 2.1, 2.2, 3.1, 3.4, 3.6_

  - [x] 3.3 Add first-class candidate-project distinction and grounding bias in the RAG
    - In `src/core/include/rtai/mini_agent.hpp`:
      - Add `const std::vector<std::string>& candidate_project_terms() const noexcept` built in `rebuild_index()` from `RagDocument.name` + high-frequency chunk titles (folded)
      - Add `bool cites_candidate_project(std::string_view query) const` — true when the query mentions any project term as a whole word
      - Add `bool is_candidate_project{false}` to `RagChunk`, set in `add_text_chunks` for chunks originating from `profile_.documents`
      - In `decide_rag_for_query`: when `cites_candidate_project(query)` is true, add a strong bonus (≈ +1.75) to `is_candidate_project` chunks containing the cited term and a penalty (≈ -0.75) to `is_cultural_or_company` chunks NOT containing the term; and replace the "open question → `chunks_[0..1]`" fallback with the top chunks of the cited project
      - **Guard**: when `cites_candidate_project(query) == false`, the scoring and fallback MUST be byte-for-byte the current path (the fix is a guarded extension, so the old BM25 path is literally untouched)
    - _Bug_Condition: isBugCondition(X) — projectMisground branch (design "Bug Condition")_
    - _Expected_Behavior: retrieved chunks belong to cited_project; target-company product never described as candidate work (design Property 1b)_
    - _Preservation: no-project-cited queries decided via unchanged BM25/fallback (3.3)_
    - _Requirements: 2.3, 2.4, 3.3_

  - [x] 3.4 Ensure the enriched trigger flows into rag_query
    - In `src/core/include/rtai/copilot_prompt.hpp`, make NO signature change; `build_copilot_messages` already builds `rag_query = trigger_text + "\n" + tail(history)`
    - Confirm (at the engine call-site from 3.2) that the `trigger_text` passed is the enriched one, so the project term is present in `rag_query`; keep the target-company-vs-projects system prompt and the "REGRA DE OURO ANTI-ALUCINAÇÃO" block unchanged
    - _Bug_Condition: isBugCondition(X) — truncated rag_query (Root Cause 3)_
    - _Expected_Behavior: rag_query includes the project term so B-chunks are retrievable (Req 2.3)_
    - _Preservation: prompt structure and system prompt unchanged_
    - _Requirements: 2.3, 2.4_

  - [x] 3.5 Fix the Mini-Compact model id and make the fallback observable (Req 2.5)
    - Correct `kCompactAnalysisModel` (currently `"qwen/qwen3.6-flash"`) to a valid OpenRouter slug consistent with the project's presets; confirm the exact id against `src/net/winhttp_llm_client.cpp`, `openrouter_protocol.hpp`, settings, and OpenRouter conventions before finalizing
    - In `src/app/src/main.cpp`, in the deep-reading `on_done` (which today emits a `NoticeEvent` only on `Completed`), add a branch for `r.status != Completed` (or empty buffer) that emits `NoticeEvent{NoticeLevel::Warning, "Mini-Compact profundo indisponível (modelo '<id>' falhou: <erro>); usando resumo sintético local."}`, so the degradation to `synthesize_deep_mini_compact()` is no longer silent
    - _Bug_Condition: isBugCondition — correlated cause 1.5 (invalid model id, silent fallback)_
    - _Expected_Behavior: valid model id + observable Warning on failure (Req 2.5)_
    - _Preservation: success path and synthetic fallback behavior otherwise unchanged_
    - _Requirements: 2.5_

- [x] 4. Verify the fix against the exploration and preservation tests

  - [x] 4.1 Build the core_tests target
    - Configure/build via CMake and build the `core_tests` target (e.g. `cmake --build build --target core_tests`); the project builds via CMake
    - Ensure the new `test_subject_fusion_properties.cpp` and `test_rag_grounding_properties.cpp` are compiled (registered in `tests/core_tests/CMakeLists.txt`) and that `test_copilot.cpp` extensions compile
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 4.2 Verify the bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Subject fusion and candidate-project grounding at the generation trigger
    - **IMPORTANT**: Re-run the SAME tests from task 1 — do NOT write new tests
    - The task-1 test encodes the expected behavior; passing confirms both symptoms are resolved (subject present in the speculative trigger; cited-project chunks retrieved and no target-company-as-candidate-work)
    - Run the exploration tests from task 1
    - **EXPECTED OUTCOME**: Tests PASS (confirms the bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
    - _Validates: Property 1 (Bug Condition → Expected Behavior)_

  - [x] 4.3 Verify the preservation tests still pass
    - **Property 2: Preservation** - Non-buggy inputs unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run the preservation property tests from task 2 and the existing suite (including `DecisionPolicy`/Pin-on-Speak/stitching coverage)
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions for all NOT isBugCondition(X) inputs)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
    - _Validates: Property 2 (Preservation)_

  - [x] 4.4 Add the two-turn integration flow to test_copilot.cpp
    - Extend `tests/core_tests/test_copilot.cpp`: drive two [Outros] turns (subject + follow-up) through `CopilotEngine`; assert the message sent to the fake LLM contains the subject on BOTH the speculative and closed paths, and that the overlay shows the literal trigger utterance
    - Add a context-switch case: a target-company question followed by a candidate-project question, confirming grounding alternates correctly and never describes the target-company product as candidate work
    - Add a deep-reading case with a simulated invalid/failing model: confirm a Warning `NoticeEvent` is emitted and `synthesize_deep_mini_compact` is used as the observable fallback
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
    - _Validates: Property 1, Property 2_

- [x] 5. Checkpoint - Ensure all tests pass
  - Run the full `core_tests` target and confirm every test passes (exploration now green, preservation still green, integration green)
  - Confirm the OpenRouter model id was validated against the net client/protocol/settings
  - If any question or ambiguity arises (e.g. the exact valid model slug), ask the user before proceeding
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

---

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"], "dependsOn": [] },
    { "wave": 2, "tasks": ["2"], "dependsOn": ["1"] },
    { "wave": 3, "tasks": ["3.1", "3.3", "3.5"], "dependsOn": ["2"] },
    { "wave": 4, "tasks": ["3.2"], "dependsOn": ["3.1"] },
    { "wave": 5, "tasks": ["3.4"], "dependsOn": ["3.2"] },
    { "wave": 6, "tasks": ["4.1"], "dependsOn": ["3.2", "3.3", "3.4", "3.5"] },
    { "wave": 7, "tasks": ["4.2", "4.3", "4.4"], "dependsOn": ["4.1"] },
    { "wave": 8, "tasks": ["5"], "dependsOn": ["4.2", "4.3", "4.4"] }
  ]
}
```

```
1. Bug Condition exploration test (FAILS on unfixed code)
         │
         ▼
2. Preservation property tests (PASS on unfixed code)
         │
         ▼
3. Implement the fix
   ├─ 3.1 Pure subject-fusion units (is_subject_bearing, enrich_trigger_with_subject)
   │        │
   │        ▼
   ├─ 3.2 Wire enriched trigger into on_turn + speculative paths  ◄── depends on 3.1
   │        │
   │        ▼
   ├─ 3.4 Enriched trigger flows into rag_query                    ◄── depends on 3.2
   ├─ 3.3 Candidate-project detection + grounding bias (independent of 3.1/3.2)
   └─ 3.5 Mini-Compact model id + observable fallback (independent)
         │
         ▼  (all of 3.x complete)
4. Verify
   ├─ 4.1 Build core_tests target                 ◄── depends on 3.1–3.5
   ├─ 4.2 Exploration test now PASSES             ◄── depends on 4.1
   ├─ 4.3 Preservation tests still PASS           ◄── depends on 4.1
   └─ 4.4 Two-turn integration flow in test_copilot ◄── depends on 4.1
         │
         ▼
5. Checkpoint - all tests pass                     ◄── depends on 4.2, 4.3, 4.4
```

**Critical path:** 1 → 2 → 3.1 → 3.2 → 3.4 → 4.1 → 4.2 → 5
**Parallelizable within task 3:** 3.3 and 3.5 can proceed independently of the 3.1→3.2→3.4 chain.

---

## Notes

- This is a bugfix spec that follows the exploratory bug-condition methodology: the exploration test (task 1) is written and confirmed to FAIL on unfixed code before any fix, and the preservation tests (task 2) are written and confirmed to PASS on unfixed code before any fix.
- Tasks 4.2 and 4.3 re-run the SAME tests authored in tasks 1 and 2 — no new tests are written during verification. The exploration test flips from FAIL to PASS (bug fixed) while the preservation tests stay PASS (no regressions).
- The wave definitions in the JSON block above mirror the ASCII dependency graph and the critical path; they do not change task content, IDs, ordering, or the Bug_Condition/Expected_Behavior/Preservation/Requirements annotations.
- The fix is a guarded extension: when `cites_candidate_project(query) == false` and when a turn is not subject-bearing or is outside the fusion window, the original code paths are byte-for-byte unchanged, preserving existing behavior.
