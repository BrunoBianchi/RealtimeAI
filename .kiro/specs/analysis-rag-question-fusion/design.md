# Analysis RAG Question Fusion Bugfix Design

## Overview

Este documento descreve a correção de dois defeitos encadeados observados numa sessão real de entrevista (empresa-alvo Tako) do copiloto RealTimeAI:

- **Sintoma A — pergunta multi-cláusula truncada.** Uma pergunta do recrutador ([Outros]/loopback) partida em duas cláusulas com pausa natural ("Pensando agora na competição em que desenvolveu o Tech Finance..." [pausa] "...como você decidiu o que fazer primeiro?") excede o `boundary_grace_ms` (450 ms) do `TurnAssembler`, fecha dois turnos separados, e o caminho **especulativo** (`on_speculative` / `enter_speculating`) dispara a geração a partir do interim parcial da segunda cláusula — antes do enriquecimento "Context-Aware Trigger Resolution" que só roda no caminho de turno fechado (`on_turn`). O LLM e o RAG perdem o assunto (TechFinance).
- **Sintoma B — má-ancoragem (misgrounding) RAG entre empresa-alvo e projeto do candidato.** Quando o recrutador cita um projeto do candidato (ex.: Midea), o query chega truncado (sem o termo do projeto) ou cai no fallback "pergunta aberta → top 2 chunks", e o BM25 ancora no dossiê da empresa-alvo (Tako) / `mini_compact`, levando o modelo a descrever o produto da empresa-alvo como se fosse trabalho do candidato.
- **Causa correlata (Req 2.5).** O passo Deep-Reading Mini-Compact usa `kCompactAnalysisModel = "qwen/qwen3.6-flash"`, um identificador suspeito de ser inválido no OpenRouter. Quando o passo falha, o callback `on_done` em `main.cpp` só notifica no sucesso; a falha degrada silenciosamente para `synthesize_deep_mini_compact()` (resumo sintético mais fraco), sem observabilidade.

A estratégia geral é **unificar a origem do "trigger enriquecido"** num único predicado/função pura reutilizável que ambos os caminhos (fechado e especulativo) chamam, **alinhar o rag_query a esse trigger enriquecido**, **tornar a distinção empresa-alvo vs. projeto-do-candidato de primeira classe no RAG** com um viés explícito quando um projeto é citado, e **corrigir o id do modelo + tornar o fallback observável**. Todas as mudanças de lógica ficam em classes header-only puras sob `src/core/include/rtai/`, seguindo a convenção pure-core, com testes property-based em `tests/core_tests/`.

## Glossary

- **Bug_Condition (C)**: A condição que dispara o bug — `multiClauseSplit OR projectMisground` conforme `isBugCondition(X)` em `bugfix.md`.
- **Property (P)**: O comportamento desejado quando `C(X)` é verdadeiro — a geração vê a pergunta inteira (assunto + follow-up) e o RAG recupera os chunks do projeto citado, sem descrever o produto da empresa-alvo como trabalho do candidato.
- **Preservation**: Para toda entrada não-buggy (`NOT C(X)`), `F'(X) = F(X)` — montagem de turno, stitching, decisão de RAG, gatilhos e Pin-on-Speak permanecem idênticos.
- **F / F'**: Comportamento original (antes do fix) / corrigido (após o fix).
- **TurnAssembler**: Classe em `src/core/include/rtai/turn_assembler.hpp` que transforma resultados do Deepgram em turnos ("falas") e já faz stitching de turnos consecutivos da mesma lane com gap < 1200 ms no `close()`.
- **Context-Aware Trigger Resolution**: O bloco em `copilot_engine.cpp` (`on_turn`, ~linhas 565-595) que prepende o turno anterior de [Outros] portador de assunto ao turno-gatilho quando detecta "pensando", "sobre", "projeto", "no ", "na ", "em ", "passando".
- **isSubjectBearing**: Novo predicado puro que substitui a heurística frágil de substring por uma regra clara de "este turno carrega o assunto/tópico de uma pergunta subsequente".
- **enrich_trigger_with_subject**: Nova função pura que, dado o turno anterior e o turno-gatilho de [Outros], retorna o trigger enriquecido (assunto + follow-up) — chamada por AMBOS os caminhos (fechado e especulativo).
- **MiniAgentRag**: Engine BM25 in-memory em `src/core/include/rtai/mini_agent.hpp`; `decide_rag_for_query` decide quais chunks anexar.
- **candidate-project**: Projeto pessoal/profissional do candidato presente nos documentos do RAG (ex.: TechFinance, Midea), distinto da empresa-alvo onde a entrevista ocorre.
- **target-company chunk**: Chunk marcado `is_cultural_or_company` (dossiê da empresa, descrição da vaga, instruções) — a empresa onde a entrevista ocorre.

## Bug Details

### Bug Condition

O bug se manifesta em duas formas. **A (`multiClauseSplit`)**: um turno-gatilho de [Outros] cujo turno imediatamente anterior, também de [Outros], carrega o assunto (`isSubjectBearing`) e foi separado por uma pausa que excedeu o grace de fechamento mas ainda está dentro da janela de fusão. **B (`projectMisground`)**: a fala do recrutador cita um projeto do candidato que existe no RAG, mas o contexto recuperado ancorou na empresa-alvo (dossiê / `mini_compact`) em vez dos chunks desse projeto. O caminho especulativo (`enter_speculating`/`on_speculative`) é o vetor primário de A porque dispara a geração ANTES do enriquecimento do caminho fechado.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type RecruiterTurnContext
         { source, prev_turn, curr_turn, gap_ms, rag_query, cited_project }
  OUTPUT: boolean

  multiClauseSplit ←
       input.source = Loopback
   AND input.prev_turn.source = Loopback
   AND isSubjectBearing(input.prev_turn.text)
   AND (input.curr_turn.start_ms - input.prev_turn.end_ms) < FUSION_WINDOW_MS
   AND generationFiredWithoutSubject(input)   // caminho especulativo pré-enriquecimento

  projectMisground ←
       input.source = Loopback
   AND citesCandidateProject(input.rag_query OR input.prev_turn.text)
   AND retrievedContextAnchorsOnTargetCompany(input)

  RETURN multiClauseSplit OR projectMisground
END FUNCTION
```

### Examples

- **A1 (bug)**: prev=[Outros] "Pensando agora na competição em que desenvolveu o Tech Finance" (fechado), curr=[Outros] "como você decidiu o que fazer primeiro?" com gap ≈ 600 ms. Esperado: trigger = "Pensando ... Tech Finance ... como você decidiu o que fazer primeiro?". Atual: a especulação dispara só com "como você decidiu o que fazer primeiro" e o RAG não vê "Tech Finance". (seqs 124-127, 134-139)
- **B1 (bug)**: recrutador "Me conta sobre o projeto Midea". Esperado: chunks do Midea (PoC Speech-to-Text na UNIFEI). Atual: resposta descreve folha determinística / eSocial da Tako como se fosse do candidato. (seqs 157-160)
- **A2 (borda, não-bug)**: prev=[Outros] "Beleza." (small-talk, NÃO subject-bearing), curr=[Outros] "como você decidiu o que fazer primeiro?". Esperado: comportamento idêntico ao atual — sem fusão (preserva 3.1).
- **B2 (borda, não-bug)**: "qual o prazo de implantação?" — nenhum projeto do candidato citado. Esperado: BM25 + fallbacks atuais inalterados (preserva 3.3).

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Perguntas de cláusula única (sem assunto separado por pausa) montam e enviam o turno exatamente como hoje (3.1).
- Dois turnos consecutivos da mesma fonte com gap < 1200 ms continuam costurados pelo stitching existente em `close()` (3.2).
- Perguntas que não citam nenhum projeto do candidato continuam decididas via BM25 e fallbacks atuais sem alteração (3.3).
- Gatilhos de palavra-chave, fala longa e o upgrade pergunta-após-palavra-chave dentro do cooldown continuam com a mesma semântica de `DecisionPolicy::evaluate` (3.4).
- O gate "Pin on Speak" continua enfileirando em vez de trocar o card visível quando o usuário está falando ou dentro da janela de 4000 ms (3.5).
- Divergência entre especulação e turno fechado continua abortando (gen++, RST_STREAM, buffer descartado) e publicando `SpeculativeMissEvent` (3.6).

**Scope:**
Toda entrada onde `NOT isBugCondition(X)` deve ser completamente inalterada pelo fix. Isto inclui: turnos de microfone ([Você]), turnos de cláusula única, perguntas sem projeto citado, e qualquer turno cujo anterior não seja subject-bearing. A fusão de assunto e o viés de RAG por projeto só podem agir sob `C(X)`.

> O comportamento correto para entradas buggy está definido na seção **Correctness Properties** (Property 1).

## Hypothesized Root Cause

1. **Enriquecimento só no caminho fechado (A)**: O bloco "Context-Aware Trigger Resolution" vive dentro de `on_turn()` (`copilot_engine.cpp` ~565-595). `enter_speculating()` (~676) e `on_speculative()` (~848) constroem `build_copilot_messages(..., c.text, ...)` diretamente do interim/texto especulativo, sem nunca olhar o turno anterior de [Outros]. Logo, a especulação — que é o que mais frequentemente chega primeiro ao LLM — nunca recebe o assunto.

2. **Heurística de assunto frágil (A)**: A detecção atual usa `find("no ")`, `find("na ")`, `find("em ")`, `find("sobre")`, `find("pensando")`, `find("projeto")`, `find("passando")` por substring crua sobre o texto folded. "no " casa dentro de "economi**no** ", "trabal**ho** no" etc., e a lista está duplicada em prosa no engine, impossível de testar isolada.

3. **rag_query truncado / fallback dominado pela empresa-alvo (B)**: `build_copilot_messages` monta `rag_query = trigger_text + "\n" + tail(history)`. No caminho especulativo `trigger_text` é só a 2ª cláusula; o termo do projeto (na 1ª cláusula) pode não estar no tail. Quando o BM25 não acha o termo, `decide_rag_for_query` cai no ramo "pergunta aberta → top 2 chunks" (`chunks_[0..1]`), que — pela ordem de `rebuild_index()` (documentos primeiro, depois vaga/dossiê/instruções) — pode não corresponder ao projeto citado, e o `mini_compact` sempre-presente carrega forte sinal da empresa-alvo.

4. **Sem distinção de primeira classe projeto-vs-empresa no scoring (B)**: `is_cultural_or_company` marca chunks da empresa-alvo, mas não há marcação simétrica de "chunk de projeto do candidato", nem viés negativo contra chunks da empresa quando um projeto específico é citado.

5. **Id de modelo inválido + fallback silencioso (Req 2.5)**: `kCompactAnalysisModel = "qwen/qwen3.6-flash"` não segue o padrão de slugs OpenRouter usado no resto do código (`openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`). O `on_done` em `main.cpp` só emite `NoticeEvent` no `Completed`; um `Failed`/timeout não gera notice algum e o sistema usa `synthesize_deep_mini_compact()` sem o usuário saber.

## Correctness Properties

Property 1: Bug Condition - Fusão de assunto e grounding de projeto no gatilho de geração

_For any_ input onde a condição do bug se verifica (`isBugCondition` retorna true), a função corrigida SHALL (a) para `multiClauseSplit`, construir o input de geração com `trigger_text` contendo tanto o assunto da cláusula anterior (`subjectOf(prev_turn)`) quanto o texto da cláusula-gatilho (`curr_turn.text`), via o MESMO `enrich_trigger_with_subject` chamado no caminho fechado e no especulativo; e (b) para `projectMisground`, compor um contexto cujo RAG recupera os chunks pertencentes ao projeto citado (`cited_project`) e NÃO descreve o produto da empresa-alvo como trabalho do candidato.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Preservation - Entradas não-buggy inalteradas

_For any_ input onde a condição do bug NÃO se verifica (`isBugCondition` retorna false), a função corrigida SHALL produzir exatamente o mesmo resultado que a função original, preservando: montagem/stitching de turnos de cláusula única e de gaps < 1200 ms, a decisão de RAG via BM25 e fallbacks atuais quando nenhum projeto é citado, a semântica de `DecisionPolicy::evaluate` para palavra-chave/fala-longa/upgrade, o enfileiramento Pin-on-Speak, e o aborto/`SpeculativeMissEvent` na divergência especulação-vs-turno.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

Assumindo a análise de causa correta, o fix distribui-se por quatro arquivos, com toda a lógica nova em funções/predicados puros testáveis.

**Arquivo**: `src/core/include/rtai/turn_assembler.hpp` (ou um novo `src/core/include/rtai/subject_fusion.hpp` header-only, para manter o assembler enxuto)

**Nova unidade pura 1 — predicado de assunto**:
```cpp
// Retorna true quando `text` (turno de [Outros]) introduz um assunto/tópico
// que uma pergunta subsequente provavelmente referencia. Substitui a heurística
// de substring crua por uma regra baseada em palavras-âncora + estrutura.
// Pura, sem estado, testável isoladamente.
[[nodiscard]] bool is_subject_bearing(std::string_view text) noexcept;
```
Regra: folda o texto, verifica palavras-âncora como palavra-token (via `text::contains_word` / `starts_with_word`, NÃO substring): "pensando", "pensa", "sobre", "projeto", "competicao", "passando", "falando", "considerando", mais preposições de tópico ("no", "na", "em", "da", "do") apenas quando seguidas de conteúdo e o turno NÃO é small-talk e NÃO termina já como pergunta completa autossuficiente. Isto corrige o falso-casamento de `find("no ")`.

**Nova unidade pura 2 — enriquecimento de trigger**:
```cpp
// Dado o turno anterior de [Outros] (possivelmente portador de assunto) e o
// turno/interim-gatilho, devolve o trigger enriquecido. Se prev não for
// subject-bearing, ou a janela de fusão for excedida, devolve curr inalterado
// (preservação). FUSION_WINDOW_MS default = 6000 (espelha o 6000ms do engine).
struct FusionConfig { std::int64_t fusion_window_ms{6000}; };

[[nodiscard]] std::string enrich_trigger_with_subject(
    std::optional<Turn> prev,          // último turno fechado de [Outros], se houver
    std::string_view curr_text,        // texto do turno/interim-gatilho
    std::int64_t gap_ms,               // curr.start_ms - prev.end_ms (>=0); -1 se indefinido
    const FusionConfig& cfg = {}) noexcept;
```
Comportamento: devolve `text::join_space(prev->text, curr_text)` sse `prev && prev->source==Loopback && is_subject_bearing(prev->text) && gap_ms>=0 && gap_ms < cfg.fusion_window_ms`; caso contrário devolve `std::string(curr_text)` exatamente. Esta é a ÚNICA fonte do trigger enriquecido.

**Arquivo**: `src/core/src/copilot_engine.cpp`

1. **Refatorar `on_turn`**: substituir o bloco inline "Context-Aware Trigger Resolution" por uma chamada a `enrich_trigger_with_subject(prev_loopback_turn, turn.text, gap)`, onde `prev_loopback_turn` é obtido de `convo.all()` como hoje e `gap = turn.start_ms - prev.end_ms`. Comportamento idêntico quando não subject-bearing (preserva 3.1/3.4).
2. **Enriquecer o caminho especulativo**: em `enter_speculating(c)` e `on_speculative(c)`, antes de `build_copilot_messages(..., c.text, ...)`, computar `enriched = enrich_trigger_with_subject(convo.last_from(AudioSource::Loopback), c.text, gap)` e usar `enriched` como o `trigger_text` passado a `build_copilot_messages` e gravado em `meta`/`Shadow.speculative_text`. Assim a especulação recebe o assunto (Req 2.2). A correspondência especulação-vs-turno (`speculative_match`) deve continuar comparando contra o texto do turno fechado JÁ enriquecido pelo mesmo helper, garantindo que match/diverge (3.6) se mantenha coerente.
3. O texto **exibido** no overlay (o "shown"/`SpeculativeCandidateEvent`) permanece a fala literal do gatilho — só o trigger que vai ao LLM/RAG é enriquecido, preservando a regra de nunca reescrever a pergunta mostrada.

**Arquivo**: `src/core/include/rtai/mini_agent.hpp`

1. **Detecção de projeto citado (pura)**:
```cpp
// Nomes de projeto derivados dos documentos do RAG (RagDocument.name + títulos
// de chunk de alta frequência), folded. Construído em rebuild_index().
[[nodiscard]] const std::vector<std::string>& candidate_project_terms() const noexcept;

// true se a query menciona (como palavra) algum termo de projeto do candidato.
[[nodiscard]] bool cites_candidate_project(std::string_view query) const;
```
2. **Marcação simétrica no chunk**: já existe `RagChunk::is_cultural_or_company`. Adicionar `bool is_candidate_project{false}` setado em `add_text_chunks` para os chunks originados de `profile_.documents` (os docs do candidato), tornando a distinção de primeira classe.
3. **Viés no scoring de `decide_rag_for_query`**: quando `cites_candidate_project(query)` for true e o chunk casa o(s) termo(s) do projeto citado, somar um bônus forte (ex.: `+1.75`) a chunks `is_candidate_project` que contêm o termo, e aplicar penalidade (ex.: `-0.75`) a chunks `is_cultural_or_company` que NÃO contêm o termo. Também: substituir o ramo de fallback "pergunta aberta → `chunks_[0..1]`" por, quando um projeto é citado, selecionar os top chunks DESSE projeto em vez dos dois primeiros do índice. Quando nenhum projeto é citado, o scoring e o fallback permanecem byte-a-byte os atuais (preserva 3.3).
4. **`compose_context_for_query`**: inalterado na estrutura; passa a receber o rag_query já enriquecido (vindo de `build_copilot_messages`). O bloco "REGRA DE OURO ANTI-ALUCINAÇÃO" já existente é mantido (reforça 2.4).

**Arquivo**: `src/core/include/rtai/copilot_prompt.hpp`

- `build_copilot_messages` já monta `rag_query = trigger_text + "\n" + tail(history)`. Como `trigger_text` agora chega enriquecido de ambos os caminhos, o termo do projeto estará presente (Req 2.3). Nenhuma mudança de assinatura; apenas garantir (via o call-site no engine) que o `trigger_text` passado é o enriquecido. O system prompt (distinção empresa-alvo vs. projetos) é mantido.

**Arquivo**: `src/core/include/rtai/mini_agent.hpp` + `src/app/src/main.cpp` (Req 2.5)

- Corrigir `kCompactAnalysisModel` para um slug OpenRouter válido, consistente com os presets já usados no projeto (ex.: `"qwen/qwen-2.5-72b-instruct"` ou outro slug confirmado válido no OpenRouter; o valor exato deve ser verificado contra a conta/documentação OpenRouter antes do merge — a tarefa de implementação deve confirmar o id).
- Tornar o fallback **observável**: no `on_done` do deep-reading em `main.cpp`, adicionar um ramo para `r.status != Completed` (ou buffer vazio) que emite `NoticeEvent{NoticeLevel::Warning, "Mini-Compact profundo indisponível (modelo '<id>' falhou: <erro>); usando resumo sintético local."}`. Assim a degradação deixa de ser silenciosa.

## Testing Strategy

### Validation Approach

Abordagem em duas fases: primeiro reproduzir os contraexemplos no código NÃO corrigido (demonstrar o bug), depois verificar que o fix satisfaz Fix Checking e preserva o comportamento não-buggy. A suíte usa GoogleTest com amostragem property-based por `std::mt19937` semeado (padrão já estabelecido em `test_fast_filter_properties.cpp`), pois o projeto não embarca runtime PBT dedicado; sementes fixas mantêm contraexemplos reproduzíveis.

Novos arquivos de teste em `tests/core_tests/` (registrar em `CMakeLists.txt`):
- `test_subject_fusion_properties.cpp` — Sintoma A (`is_subject_bearing`, `enrich_trigger_with_subject`).
- `test_rag_grounding_properties.cpp` — Sintoma B (`cites_candidate_project`, viés de `decide_rag_for_query`).

### Exploratory Bug Condition Checking

**Goal**: Fazer surgir contraexemplos que demonstrem o bug ANTES do fix; confirmar/refutar a análise de causa.

**Test Plan**: Construir contextos de dois turnos de [Outros] (subject-bearing + follow-up) e perfis `MiniAgentProfile` com documentos de projeto (TechFinance, Midea) + dossiê da empresa-alvo. No código não corrigido, afirmar que o trigger especulativo NÃO contém o assunto e que `decide_rag_for_query` sobre a 2ª cláusula isolada não retorna chunks do projeto.

**Test Cases**:
1. **Fusão especulativa ausente**: prev "Pensando ... Tech Finance", curr "como você decidiu o que fazer primeiro?" → o trigger construído pelo caminho especulativo não contém "Tech Finance" (falha no código não corrigido).
2. **Grounding de projeto ausente**: query = só "me conta como foi" (truncado) com projeto Midea citado só no turno anterior → chunks retornados ancoram na empresa-alvo (falha no código não corrigido).
3. **Heurística frágil**: um texto como "o time economizou tempo no onboarding" dispara `find("no ")` hoje (falso positivo), demonstrando a necessidade de `is_subject_bearing` por palavra-token.
4. **Borda fora de range**: gap entre cláusulas ≈ 8000 ms (> janela de fusão) — não deve fundir (confirma limite).

**Expected Counterexamples**: trigger especulativo sem o assunto; chunks da empresa-alvo retornados para pergunta sobre projeto do candidato; falso-casamento de substring.

### Fix Checking

**Goal**: Para toda entrada onde a condição do bug vale, a função corrigida produz o comportamento esperado.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  // A
  trigger := enrich_trigger_with_subject(input.prev_turn, input.curr_turn.text, input.gap_ms)
  ASSERT contains(trigger, subjectOf(input.prev_turn)) AND contains(trigger, input.curr_turn.text)
  // B
  ctx := compose_context_for_query(enrichedQuery(input))
  ASSERT retrievedChunksBelongTo(ctx, input.cited_project)
     AND NOT describesTargetCompanyProductAsCandidateWork(ctx)
END FOR
```

### Preservation Checking

**Goal**: Para toda entrada onde a condição do bug NÃO vale, a função corrigida produz o mesmo resultado que a original.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT enrich_trigger_with_subject(prev, curr, gap) = curr      // sem fusão
  ASSERT decide_rag_for_query_fixed(query) = decide_rag_for_query_original(query)  // sem projeto citado
END FOR
```

**Testing Approach**: PBT (amostragem semeada) é adequado para preservação porque gera muitos casos automaticamente, cobre bordas que testes manuais perdem, e dá garantia forte de que o comportamento é idêntico para todas as entradas não-buggy. Para `decide_rag_for_query`, a referência de preservação é o resultado do ramo atual quando `cites_candidate_project(query) == false` — a implementação corrigida deve ser uma extensão guardada por esse predicado, de modo que o caminho antigo seja literalmente intocado.

**Test Plan**: Observar o comportamento no código NÃO corrigido para turnos de cláusula única, gaps < 1200 ms, e perguntas sem projeto citado; depois escrever as properties capturando esse comportamento.

**Test Cases**:
1. **Preservação de cláusula única**: prev não subject-bearing (ou inexistente) ⇒ `enrich_trigger_with_subject` devolve `curr` idêntico, byte-a-byte.
2. **Preservação do stitching**: dois turnos da mesma lane com gap < 1200 ms ⇒ `TurnAssembler::close` costura como hoje (sem regressão no assembler).
3. **Preservação do RAG sem projeto**: para queries sem termo de projeto, `decide_rag_for_query` (needed, reason, conjunto de chunks) é idêntico ao original em um corpus fixo.
4. **Preservação de gatilhos/Pin-on-Speak**: `DecisionPolicy::evaluate` e o enfileiramento permanecem com a mesma semântica (coberto pelos testes existentes; estender com casos onde a fusão poderia interferir e confirmar que não interfere).

### Unit Tests

- `is_subject_bearing`: positivos ("Pensando no Tech Finance", "sobre o projeto Midea", "falando da arquitetura"), negativos ("Beleza.", "Tudo bem?", "o time economizou no onboarding" — sem falso-casamento de substring).
- `enrich_trigger_with_subject`: fusão dentro da janela; sem fusão fora da janela; sem fusão quando prev não é [Outros]; sem fusão quando prev não é subject-bearing; `gap_ms == -1`.
- `cites_candidate_project`: casa "TechFinance"/"Midea" como palavra; não casa substrings parciais; vazio quando não há documentos.
- Deep-reading fallback: com id de modelo que falha, verifica que um `NoticeEvent` de Warning é emitido (teste no nível do callback / harness de engine).

### Property-Based Tests

- **Property 1A (fusão)**: para pares (prev subject-bearing, curr) gerados com gap aleatório < janela, `enrich_trigger_with_subject` sempre contém tanto o assunto quanto `curr`. Referência independente: `prev.text` e `curr` recomputados do gerador.
- **Property 1B (grounding)**: para perfis com ≥1 projeto e dossiê de empresa, quando a query cita o projeto, o conjunto de chunks retornado contém ≥1 chunk `is_candidate_project` do projeto citado e nenhum chunk `is_cultural_or_company` domina o topo.
- **Property 2 (preservação)**: para entradas não-buggy geradas aleatoriamente (prev não subject-bearing OU sem projeto citado), `enrich_trigger_with_subject` devolve `curr` inalterado e `decide_rag_for_query_fixed == decide_rag_for_query_original`.

### Integration Tests

- Fluxo de dois turnos de [Outros] (assunto + follow-up) através de `CopilotEngine` (estendendo `test_copilot.cpp`): afirmar que a mensagem enviada ao LLM fake contém o assunto tanto no caminho especulativo quanto no fechado, e que o overlay exibe a fala literal do gatilho.
- Troca de contexto: pergunta sobre empresa-alvo seguida de pergunta sobre projeto do candidato, confirmando que o grounding alterna corretamente e nunca descreve o produto da empresa-alvo como trabalho do candidato.
- Deep-reading com modelo inválido simulado: confirmar notice de Warning e uso do `synthesize_deep_mini_compact` como fallback observável.
