# Bugfix Requirements Document

## Introduction

Em uma sessão real de entrevista com a empresa-alvo Tako, o copiloto RealTimeAI apresentou dois defeitos encadeados que degradam gravemente a qualidade das sugestões ao vivo.

**Sintoma A — Pergunta multi-cláusula truncada enviada ao LLM.** Quando o recrutador ([Outros]/loopback) faz uma pergunta dividida em duas cláusulas com uma pausa natural no meio (ex.: "Pensando agora na competição em que desenvolveu o Tech Finance..." [pausa] "...como você decidiu o que fazer primeiro?"), a pausa excede `boundary_grace_ms` (450 ms) e o `TurnAssembler` fecha dois turnos separados. O caminho especulativo (`on_speculative`/`enter_speculating`) dispara a geração usando apenas o interim parcial da segunda cláusula, antes do enriquecimento "Context-Aware Trigger Resolution" que só roda no caminho de turno fechado. O LLM recebe só "como você decidiu o que fazer primeiro", perdendo o assunto (TechFinance). Evidência: seqs 124-127 e 134-139 da transcrição da sessão.

**Sintoma B — Confusão/alucinação entre empresa-alvo e projeto do candidato.** Quando o recrutador cita um projeto do candidato (ex.: Midea — PoC de Speech-to-Text na UNIFEI), a resposta gerada descreve o produto da empresa-alvo (Tako: folha de pagamento determinística, integração eSocial) como se fosse o projeto do candidato. Isso ocorre porque `MiniAgentRag::decide_rag_for_query` faz BM25 sobre um query que pode chegar truncado (sem o termo do projeto) e/ou cai no fallback "pergunta aberta → top 2 chunks", onde o dossiê da empresa-alvo e o `mini_compact` dominam o índice. Evidência: seqs 157-160 da transcrição.

O impacto é direto: o candidato recebe uma sugestão fora de assunto ou factualmente falsa durante a entrevista ao vivo, quebrando a persona e a confiança no copiloto.

**Bug Condition (C(X))** — identifica as entradas que disparam o bug:

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type RecruiterTurnContext
         { source, prev_turn, curr_turn, gap_ms, rag_query, cited_project }
  OUTPUT: boolean

  // A: pergunta multi-cláusula de [Outros] cujo turno anterior (também [Outros])
  //    carrega o assunto e foi separado por uma pausa que excede o grace de
  //    fechamento mas ainda está dentro da janela de fusão.
  multiClauseSplit ←
       X.source = Loopback
   AND X.prev_turn.source = Loopback
   AND isSubjectBearing(X.prev_turn.text)
   AND (X.curr_turn.start_ms - X.prev_turn.end_ms) < FUSION_WINDOW_MS

  // B: a fala do recrutador cita um projeto do candidato que existe no RAG,
  //    mas o contexto recuperado ancorou na empresa-alvo (dossiê/mini_compact)
  //    em vez dos chunks desse projeto.
  projectMisground ←
       X.source = Loopback
   AND citesCandidateProject(X.rag_query)     // ex.: "Midea", "TechFinance"
   AND retrievedContextAnchorsOnTargetCompany(X)

  RETURN multiClauseSplit OR projectMisground
END FUNCTION
```

**Property (Fix Checking)** — comportamento correto para entradas buggy:

```pascal
// Propriedade A: a geração vê a pergunta inteira com o assunto.
FOR ALL X WHERE isBugCondition(X) AND multiClauseSplit(X) DO
  prompt ← buildGenerationInput'(X)
  ASSERT contains(prompt.trigger_text, subjectOf(X.prev_turn))
     AND contains(prompt.trigger_text, X.curr_turn.text)
END FOR

// Propriedade B: o RAG recupera os chunks do projeto citado e a resposta
// nunca descreve o produto da empresa-alvo como projeto do candidato.
FOR ALL X WHERE isBugCondition(X) AND projectMisground(X) DO
  ctx ← composeContext'(X)
  ASSERT retrievedChunksBelongTo(ctx, X.cited_project)
     AND NOT describesTargetCompanyProductAsCandidateWork(ctx)
END FOR
```

**Preservation (Preservation Checking)** — para toda entrada não-buggy, o código corrigido se comporta de forma idêntica ao original:

```pascal
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
END FOR
```

Onde **F** é o comportamento atual (antes do fix) e **F'** é o comportamento corrigido.

## Bug Analysis

### Current Behavior (Defect)

O que acontece hoje quando o bug é disparado.

1.1 WHEN o recrutador ([Outros]) faz uma pergunta em duas cláusulas com uma pausa que excede `boundary_grace_ms` (450 ms) THEN o sistema fecha dois turnos separados e envia ao LLM apenas a segunda cláusula, perdendo o assunto citado na primeira (ex.: "TechFinance").

1.2 WHEN o caminho especulativo (`on_speculative`/`enter_speculating`) dispara a geração a partir do interim parcial da segunda cláusula THEN o sistema gera a sugestão sem aplicar o enriquecimento "Context-Aware Trigger Resolution", que só executa no caminho de turno fechado.

1.3 WHEN o recrutador cita um projeto do candidato (ex.: "Midea", "TechFinance") mas o query chega truncado sem o termo do projeto THEN o sistema recupera chunks errados ou cai no fallback "pergunta aberta → top 2 chunks", ancorando no dossiê da empresa-alvo e no `mini_compact`.

1.4 WHEN o recrutador pergunta sobre o projeto Midea do candidato THEN o sistema responde descrevendo o produto da empresa-alvo (Tako: folha determinística, integração eSocial) como se fosse projeto do candidato (seqs 157-160).

1.5 WHEN o Deep-Reading Mini-Compact é gerado usando `kCompactAnalysisModel = "qwen/qwen3.6-flash"` e esse identificador não é um modelo válido THEN o passo profundo falha e o sistema cai no resumo sintético fraco (`synthesize_deep_mini_compact`), reduzindo a fidelidade factual do contexto sempre presente.

### Expected Behavior (Correct)

O que deve acontecer no lugar.

2.1 WHEN o recrutador ([Outros]) faz uma pergunta em duas cláusulas com uma pausa dentro da janela de fusão THEN the system SHALL montar a pergunta completa (assunto da primeira cláusula + segunda cláusula) antes de disparar a geração.

2.2 WHEN o caminho especulativo for acionado para um turno de [Outros] cujo turno anterior de [Outros] carrega o assunto THEN the system SHALL aplicar o mesmo enriquecimento de assunto usado no caminho de turno fechado, de modo que a geração especulativa também receba o assunto citado.

2.3 WHEN o recrutador cita um projeto do candidato presente no RAG THEN the system SHALL recuperar os chunks DESSE projeto, mesmo quando o termo do projeto vier apenas no turno anterior e não no turno-gatilho.

2.4 WHEN o recrutador pergunta sobre um projeto do candidato (ex.: Midea) THEN the system SHALL basear a resposta exclusivamente nos chunks desse projeto e NÃO SHALL descrever o produto da empresa-alvo (Tako) como se fosse trabalho do candidato.

2.5 WHEN o Deep-Reading Mini-Compact for solicitado THEN the system SHALL usar um identificador de modelo válido e, em caso de falha, SHALL registrar o fallback de forma observável sem silenciosamente degradar a fidelidade.

### Unchanged Behavior (Regression Prevention)

Comportamento existente que deve ser preservado.

3.1 WHEN o recrutador faz uma pergunta de cláusula única (sem pausa que separe o assunto) THEN the system SHALL CONTINUE TO montar e enviar o turno exatamente como hoje.

3.2 WHEN dois turnos consecutivos da mesma fonte ocorrem com gap menor que 1200 ms THEN the system SHALL CONTINUE TO costurá-los pelo stitching existente no `close()` do `TurnAssembler`.

3.3 WHEN uma pergunta não cita nenhum projeto do candidato THEN the system SHALL CONTINUE TO decidir o RAG via BM25 e os fallbacks atuais sem alteração.

3.4 WHEN a pergunta aciona o gatilho de palavra-chave, fala longa ou o upgrade pergunta-após-palavra-chave dentro do cooldown THEN the system SHALL CONTINUE TO disparar com a mesma semântica de `DecisionPolicy::evaluate`.

3.5 WHEN o gate "Pin on Speak" indica que o usuário está falando ou dentro da janela de 4000 ms THEN the system SHALL CONTINUE TO enfileirar a sugestão em vez de trocar o card visível.

3.6 WHEN a especulação diverge do turno fechado THEN the system SHALL CONTINUE TO abortar a especulação (gen++, RST_STREAM, buffer descartado) e publicar `SpeculativeMissEvent` como hoje.
