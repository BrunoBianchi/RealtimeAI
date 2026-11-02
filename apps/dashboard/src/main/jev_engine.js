const fs = require('fs');
const path = require('path');
const { getCompanySvgLogo } = require('./company_logos');
const { resolveAndCacheCompanyLogo, deriveDomainFromCompanyName } = require('./company_logo_service');

// Questions shipped by older builds as sample content ("q-nu-01"...). They
// were never asked in a real session, so they are purged on load.
const SAMPLE_QUESTION_ID = /^q-[a-z0-9]+-\d+$/i;

/**
 * Enterprise & Technology Companies Dictionary for accurate transcript detection.
 */
const KNOWN_COMPANIES = [
  { name: 'Accenture', id: 'accenture', domain: 'accenture.com', aliases: ['accenture'] },
  { name: 'Tata Consultancy Services', id: 'tcs', domain: 'tcs.com', aliases: ['tata consultancy services', 'tata consultancy', 'tcs', 'tata'] },
  { name: 'Infosys', id: 'infosys', domain: 'infosys.com', aliases: ['infosys'] },
  { name: 'Capgemini', id: 'capgemini', domain: 'capgemini.com', aliases: ['capgemini'] },
  { name: 'Deloitte', id: 'deloitte', domain: 'deloitte.com', aliases: ['deloitte'] },
  { name: 'HCLTech', id: 'hcltech', domain: 'hcltech.com', aliases: ['hcltech', 'hcl technologies', 'hcl'] },
  { name: 'Wipro Limited', id: 'wipro', domain: 'wipro.com', aliases: ['wipro limited', 'wipro'] },
  { name: 'Cognizant', id: 'cognizant', domain: 'cognizant.com', aliases: ['cognizant', 'cognizant technology solutions'] },
  { name: 'LTIMindtree', id: 'ltimindtree', domain: 'ltimindtree.com', aliases: ['ltimindtree', 'lti mindtree', 'mindtree'] },
  { name: 'EY', id: 'ey', domain: 'ey.com', aliases: ['ey', 'ernst & young', 'ernst and young'] },
  { name: 'Mphasis', id: 'mphasis', domain: 'mphasis.com', aliases: ['mphasis'] },
  { name: 'Tech Mahindra', id: 'techmahindra', domain: 'techmahindra.com', aliases: ['tech mahindra', 'mahindra'] },
  { name: 'CGI Inc.', id: 'cgi', domain: 'cgi.com', aliases: ['cgi inc', 'cgi group', 'cgi'] },
  { name: 'EPAM Systems', id: 'epam', domain: 'epam.com', aliases: ['epam systems', 'epam'] },
  { name: 'Persistent Systems', id: 'persistent', domain: 'persistent.com', aliases: ['persistent systems', 'persistent'] },
  { name: 'Coforge', id: 'coforge', domain: 'coforge.com', aliases: ['coforge'] },
  { name: 'Nubank', id: 'nubank', domain: 'nubank.com.br', aliases: ['nubank', 'nu bank', 'nu'] },
  { name: 'Google', id: 'google', domain: 'google.com', aliases: ['google', 'alphabet'] },
  { name: 'Amazon', id: 'amazon', domain: 'amazon.com', aliases: ['amazon', 'aws', 'amazon web services'] },
  { name: 'Microsoft', id: 'microsoft', domain: 'microsoft.com', aliases: ['microsoft', 'azure'] },
  { name: 'Meta', id: 'meta', domain: 'meta.com', aliases: ['meta', 'facebook'] },
  { name: 'Apple', id: 'apple', domain: 'apple.com', aliases: ['apple'] },
  { name: 'Netflix', id: 'netflix', domain: 'netflix.com', aliases: ['netflix'] },
  { name: 'Uber', id: 'uber', domain: 'uber.com', aliases: ['uber'] },
  { name: 'Spotify', id: 'spotify', domain: 'spotify.com', aliases: ['spotify'] },
  { name: 'Stripe', id: 'stripe', domain: 'stripe.com', aliases: ['stripe'] },
  { name: 'Salesforce', id: 'salesforce', domain: 'salesforce.com', aliases: ['salesforce'] },
  { name: 'Oracle', id: 'oracle', domain: 'oracle.com', aliases: ['oracle'] },
  { name: 'IBM', id: 'ibm', domain: 'ibm.com', aliases: ['ibm'] },
  { name: 'Mercado Livre', id: 'mercadolivre', domain: 'mercadolibre.com', aliases: ['mercado livre', 'mercadolibre', 'meli'] },
  { name: 'Itaú', id: 'itau', domain: 'itau.com.br', aliases: ['itau', 'itaú', 'itau unibanco'] },
  { name: 'Bradesco', id: 'bradesco', domain: 'bradesco.com.br', aliases: ['bradesco'] }
];

/**
 * Detects which company the interview is for based on the transcript text.
 * Uses greeting cues, interviewer introductions, entity scoring, and fallback.
 */
function detectCompanyFromTranscript(transcriptText, fallbackName = '') {
  if (!transcriptText || typeof transcriptText !== 'string') {
    const cleanFallback = (fallbackName || 'Empresa não identificada').trim();
    return {
      name: cleanFallback,
      id: cleanFallback.toLowerCase().replace(/[^a-z0-9]/g, '') || 'company',
      domain: deriveDomainFromCompanyName(cleanFallback),
      confidence: 'fallback',
      detectedFrom: 'fallback_goal'
    };
  }

  const lines = transcriptText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const totalLines = lines.length;

  // 1. Check conversational greeting and context patterns
  const greetingPatterns = [
    /(?:welcome to|interview(?:ing)? (?:at|with|for)|here at|apply(?:ing)? to|position at|role at|team at|join(?:ing)? (?:this |the )?|why)\s+([A-Z][A-Za-z0-9&.\s]{1,30}?)(?=[,.\n!?]|\s+\b(?:is|has|we|team|interview|round|today|and|in|for)\b|$)/i,
    /(?:bem-vindo (?:ao|à|a)|entrevista (?:na|no|com a|com o|para o|para a)|aqui (?:na|no)|trabalhar (?:na|no)|vaga (?:na|no))\s+([A-Z][A-Za-z0-9&.\s]{1,30}?)(?=[,.\n!?]|\s+\b(?:hoje|é|para|onde|e)\b|$)/i,
    /(?:what do you know about|tell me what you know about|o que você sabe sobre|por que você quer trabalhar na|por que a|why)\s+([A-Z][A-Za-z0-9&.\s]{1,30}?)(?=[,.\n!?]|\s+\b(?:and|today|e)\b|$)/i
  ];

  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i];
    for (const pat of greetingPatterns) {
      const match = line.match(pat);
      if (match && match[1]) {
        const candidate = match[1].trim();
        // Check if candidate matches a known company
        let known = KNOWN_COMPANIES.find((c) =>
          c.aliases.some((alias) => alias.toLowerCase() === candidate.toLowerCase()) ||
          c.name.toLowerCase() === candidate.toLowerCase()
        );
        if (!known) {
          known = KNOWN_COMPANIES.find((c) =>
            c.aliases.some((alias) => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line))
          );
        }
        if (known) {
          return {
            name: known.name,
            id: known.id,
            domain: known.domain,
            confidence: 0.95,
            confidenceLevel: 'high',
            detectedFrom: `greeting: "${match[0]}"`
          };
        }
        // If not explicitly in known list, but valid capitalized name (3 to 30 chars, not common stop words)
        const stopWords = /^(the|this|that|our|your|an?|my|some|any|all|th|here|there|we|us|you|round|interview|team)$/i;
        if (candidate.length >= 3 && candidate.length <= 30 && !stopWords.test(candidate)) {
          const cleanCand = candidate.charAt(0).toUpperCase() + candidate.slice(1);
          return {
            name: cleanCand,
            id: cleanCand.toLowerCase().replace(/[^a-z0-9]/g, ''),
            domain: deriveDomainFromCompanyName(cleanCand),
            confidence: 0.75,
            confidenceLevel: 'medium',
            detectedFrom: `greeting_pattern: "${match[0]}"`
          };
        }
      }
    }
  }

  // 2. Score entity mentions across the transcript
  const scores = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();
    const isBeginning = i < Math.max(3, totalLines * 0.25);
    const isInterviewer = !/^(you|candidate|me):\s*/i.test(line);

    for (const comp of KNOWN_COMPANIES) {
      for (const alias of comp.aliases) {
        // Word boundary match
        const regex = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(lowerLine)) {
          let pts = 1;
          if (isBeginning) pts += 4; // High weight for introductory mentions
          if (isInterviewer) pts += 2; // Interviewer mentioning their company
          scores.set(comp.id, (scores.get(comp.id) || 0) + pts);
        }
      }
    }
  }

  // Find company with highest score
  let bestCompId = null;
  let maxScore = 0;
  for (const [compId, score] of scores.entries()) {
    if (score > maxScore) {
      maxScore = score;
      bestCompId = compId;
    }
  }

  if (bestCompId && maxScore >= 2) {
    const found = KNOWN_COMPANIES.find((c) => c.id === bestCompId);
    return {
      name: found.name,
      id: found.id,
      domain: found.domain,
      confidence: maxScore >= 6 ? 0.9 : 0.7,
      confidenceLevel: maxScore >= 6 ? 'high' : 'medium',
      detectedFrom: `entity_frequency (score: ${maxScore})`
    };
  }

  // 3. Fallback to goal or specified company
  if (fallbackName && fallbackName.trim().length > 0) {
    const clean = fallbackName.trim();
    const known = KNOWN_COMPANIES.find((c) =>
      c.aliases.some((a) => a.toLowerCase() === clean.toLowerCase()) ||
      c.name.toLowerCase() === clean.toLowerCase()
    );
    if (known) {
      return {
        name: known.name,
        id: known.id,
        domain: known.domain,
        confidence: 0.6,
        confidenceLevel: 'goal_context',
        detectedFrom: 'goal_metadata'
      };
    }
    return {
      name: clean,
      id: clean.toLowerCase().replace(/[^a-z0-9]/g, '') || 'company',
      domain: deriveDomainFromCompanyName(clean),
      confidence: 0.5,
      confidenceLevel: 'goal_context',
      detectedFrom: 'goal_metadata'
    };
  }

  // Default to Accenture
  return {
    name: 'Accenture',
    id: 'accenture',
    domain: 'accenture.com',
    confidence: 0.1,
    confidenceLevel: 'default',
    detectedFrom: 'default'
  };
}

const MARKUP_RE = /\*\*|`|\$[^$\s][^$]*\$|\\(?:div|times|frac|cdot|sqrt)\b|^\s*[-*•]\s|\|\s*-{3}/;

/**
 * Validates whether a candidate string is a substantive, meaningful interview question.
 * Filters out audio tests, administrative chat, greetings, and casual noise.
 */
function validateQuestionWithJev(text) {
  if (!text || typeof text !== 'string') return { valid: false, reason: 'empty' };

  let trimmed = text.trim();
  // Strip quotes if candidate question was enclosed in quotation marks
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  // Strip common conversational filler prefixes
  trimmed = trimmed
    .replace(/^(so|okay|well|alright|cool|um|uh|now|great|yeah|yes|ok|right|então|bem|certo|legal)[,\s]+/i, '')
    .replace(/^(my next question is:?|another question:?|let me ask you:?|i want to ask you:?|question:?|minha próxima pergunta é:?|outra pergunta:?|quero te perguntar:?|pergunta:?|responda(?: por [áa]udio)?:|como eu responderia:?)[,\s]*/i, '')
    .replace(/^["“']+|["”']+$/g, '')
    .trim();

  if (trimmed.length < 18) return { valid: false, reason: 'too_short' };
  // Markdown and math come from the copilot's own answers ("**10%**",
  // "$1/5$ de 50"), never from what an interviewer says.
  if (MARKUP_RE.test(trimmed)) return { valid: false, reason: 'markup' };

  const lower = trimmed.toLowerCase();

  // Filler and administrative noise patterns to exclude
  const fillerPatterns = [
    /can you hear me/i,
    /am i audible/i,
    /can you see my screen/i,
    /is your audio/i,
    /sorry (i was|about) (on )?mute/i,
    /you are on mute/i,
    /give me a (second|moment|minute)/i,
    /how are you( doing)?( today)?/i,
    /how is your day/i,
    /nice to meet you/i,
    /did you get the (link|invite|document)/i,
    /are you ready/i,
    /shall we start/i,
    /can we begin/i,
    /let me share my screen/i,
    /bye|goodbye|have a nice day|see you/i,
    /consegue me ouvir/i,
    /esta me ouvindo/i,
    /está me ouvindo/i,
    /consegue ver minha tela/i,
    /tudo bem com voce/i,
    /tudo bem com você/i,
    /vamos começar/i,
    /um minuto/i,
    /um segundo/i,
    /obrigado|obrigada|tchau|até logo/i,
    /testando|teste de áudio|teste de audio|esta funcionando|está funcionando/i,
    /1,\s*2,\s*testando|testando,\s*1,\s*2|latência que está demorando|latenca que esta demorando/i,
    /como que eu posso responder|opa,\s*testando|por que que eu vou fazer|porque eu consegui/i
  ];

  for (const pattern of fillerPatterns) {
    if (pattern.test(lower)) {
      return { valid: false, reason: 'conversational_filler' };
    }
  }

  // Question signals: question mark or interrogative lead words
  const hasQuestionMark = lower.includes('?');
  const hasInterrogativeLead = /^(what|how|why|when|where|who|which|can you|could you|would you|tell me|describe|walk me|explain|have you|in your experience|share an example|give an example|qual|quais|como|por que|porque|poderia|descreva|conte-me|conte sobre|conte (uma|um)|me conte|me fale|fale sobre|explique|imagine|você já|voce ja|me dê um exemplo|dê um exemplo)\b/i.test(lower);

  if (!hasQuestionMark && !hasInterrogativeLead) {
    return { valid: false, reason: 'not_a_question' };
  }

  // Substantive interview concepts (English & Portuguese)
  const substantiveTerms = [
    'experience', 'project', 'architecture', 'design', 'scale', 'database', 'system',
    'code', 'algorithm', 'performance', 'latency', 'cache', 'trade-off', 'tradeoff',
    'conflict', 'team', 'challenge', 'failure', 'deadline', 'debug', 'production',
    'api', 'microservice', 'decision', 'approach', 'solution', 'refactor', 'test',
    'security', 'schema', 'queue', 'concurrency', 'lead', 'client', 'business',
    'requirement', 'sql', 'nosql', 'distributed', 'star', 'stakeholder', 'pressure',
    'experiência', 'projeto', 'arquitetura', 'banco de dados', 'código', 'algoritmo',
    'desempenho', 'latência', 'equipe', 'desafio', 'falha', 'produção', 'microsserviço',
    'decisão', 'solução', 'refatoração', 'segurança', 'distribuído'
  ];

  const hasSubstantiveTerm = substantiveTerms.some((term) => lower.includes(term));

  // A full sentence ending in "?" is a question even without an interview
  // keyword ("Você comentou que..., como faz isso?"); JEV then decides.
  const longQuestion = hasQuestionMark && trimmed.split(/\s+/).length >= 7;
  if (!hasSubstantiveTerm && !hasInterrogativeLead && !longQuestion) {
    return { valid: false, reason: 'not_interview_question' };
  }

  // Format clean question
  let cleanText = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  if (!cleanText.endsWith('?')) cleanText += '?';

  return {
    valid: true,
    cleaned: cleanText
  };
}

/**
 * Categorizes a validated interview question into standard domains.
 */
function categorizeQuestionWithJev(questionText) {
  const lower = questionText.toLowerCase();

  // Opening, culture/motivation and past-experience questions come first:
  // they are the most common and were all falling into "Technical".
  if (/(fale (um pouco )?sobre (você|voce|sua trajetória)|sua trajetória|se apresent|tell me about yourself|walk me through your (background|resume))/iu.test(lower)) {
    return { category: 'Opening', subCategory: 'Apresentação' };
  }
  if (/(cultura|valores|por que (você|voce) quer|por que (a|o) |o que (você|voce) (mais )?(quer|busca|espera)|motiva|se identifica|why (do you want|this company|us)|culture|values)/iu.test(lower)) {
    return { category: 'Culture', subCategory: 'Cultura e motivação' };
  }
  if (/(conte(-me)? (um pouco )?sobre (o |a |seu |sua )?(projeto|experiência|trabalho)|seu projeto|sua experiência|tell me about (your|the) (project|experience))/iu.test(lower)) {
    return { category: 'Experience', subCategory: 'Projetos e experiência' };
  }

  // Behavioral (STAR) - check early so questions about conflicts/situations with architecture/code get prioritized
  if (/(tell me about a time|a time when|describe a situation|give an example|conflict|disagree|mistake|failure|pressure|deadline|teammate|stakeholder|leadership|priorit|feedback|responsibilit|star method|difficult colleague|conte sobre|conte (uma|um) (vez|situação|momento|exemplo)|me conte|uma vez em que|uma situação em que|um momento em que|teve que|precisou|dê um exemplo|assumi[ru]|responsabilidade|como (você|voce) lid(a|aria|ou)|descreva|conflito|liderança|pressão)(?!\p{L})/iu.test(lower)) {
    return { category: 'Behavioral', subCategory: 'Leadership / STAR' };
  }

  // Coding
  if (/(algorithm|data structure|leetcode|binary tree|array|string|hashmap|recursion|time complexity|o\(|write code|code implementation|regex|sort|big-o|pointer|stack|heap|algoritmo|estrutura de dados)(?!\p{L})/iu.test(lower)) {
    return { category: 'Technical', subCategory: 'Coding' };
  }

  // System Design
  if (/(system design|distributed|high availability|sharding|load balanc|throughput|latency|microservice|caching|kafka|redis|message queue|event-driven|partition|rate limit|cluster|distribuído|alta disponibilidade|mensageria)(?!\p{L})/iu.test(lower)) {
    return { category: 'Technical', subCategory: 'System design' };
  }

  // Architecture & Database
  if (/(architecture|api design|rest|grpc|database|schema|nosql|sql|postgres|aws|cloud|docker|kubernetes|design pattern|trade-off|tradeoff|migration|zero downtime|arquitetura|banco de dados|migração)(?!\p{L})/iu.test(lower)) {
    return { category: 'Technical', subCategory: 'Architecture' };
  }

  // Domain knowledge & Industry Strategy
  if (/(business|compliance|revenue|pricing|market|customer|client|regulation|saas|vendor|roi|industry|product strategy|roadmap|fintech|security compliance|negócio|cliente|mercado|estratégia)(?!\p{L})/iu.test(lower)) {
    return { category: 'Domain knowledge', subCategory: 'Industry / Strategy' };
  }

  // Default fallback
  return { category: 'General', subCategory: 'Geral' };
}

/**
 * Anonymizes any personal candidate names, emails, phone numbers, or private URLs.
 */
function anonymizeWithJev(text) {
  if (!text) return '';
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]')
    .replace(/\b\d{3}[-.\s]??\d{3}[-.\s]??\d{4}\b/g, '[phone]')
    .replace(/https?:\/\/[^\s]+/g, '[link]')
    .replace(/\b(Mr\.|Mrs\.|Ms\.|Dr\.)\s+[A-Z][a-z]+/g, 'the interviewer');
}

/**
 * Extracts validated, categorized, and anonymized questions from a session transcript.
 * Supports Markdown sessions (.md), JSONL records (.jsonl), and plain text dialogs.
 */
function extractQuestionsFromTranscript(transcriptText) {
  if (!transcriptText || typeof transcriptText !== 'string') return [];

  const candidateQuestions = [];
  const lines = transcriptText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // A session export (.md) has a timeline of labeled turns, copilot blocks
  // ("> ...") and an LLM summary at the end; only labeled interviewer turns
  // and the question quoted in a copilot block are questions there.
  const isExport = /^##\s+Timeline\s*$/m.test(transcriptText);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (isExport && /^##\s+(Summary|Resumo)\b/i.test(line)) break;
    // A copilot block is the copilot's answer, except its quoted question.
    if (line.startsWith('>') && !/^>\s*(?:Question|Pergunta|Trigger|Prompt):\s*"/i.test(line)) continue;
    // "*[02:16] Notice: ...*", "*[03:27] Suggestion rating: ...*"
    if (/^\*\[[\d:]+\]/.test(line)) continue;

    // Skip markdown metadata, headers and suggestion system fields
    if (
      line.startsWith('#') ||
      line.startsWith('- Started:') ||
      line.startsWith('- Duration:') ||
      line.startsWith('- Mode:') ||
      line.startsWith('- STT:') ||
      line.startsWith('- LLM:') ||
      line.startsWith('- Ended:') ||
      /^(?:>\s*)?(?:Understood|Suggestion|Error|Notice|Feedback|On screen|1st token):\s*/i.test(line)
    ) {
      continue;
    }

    let turnText = line;
    let isInterviewer = true;
    let labeled = false;

    // 1. Check JSONL format
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const obj = JSON.parse(line);
        // Candidate indicators: skip candidate turns
        if (
          obj.source === 'mic' ||
          obj.src === 'voce' ||
          obj.speaker === 'You' ||
          obj.speaker === 'Você' ||
          obj.speaker === 'Candidate'
        ) {
          isInterviewer = false;
        }
        // In jsonl, suggestion objects have obj.trigger for questions
        // (screenshots, recaps and follow-up lists are not questions).
        if (obj.type === 'suggestion' && /^(screenshot|recap|follow_up)$/.test(String(obj.reason || ''))) continue;
        if (obj.type === 'suggestion' && obj.trigger) {
          turnText = obj.trigger;
          isInterviewer = true;
        } else {
          turnText = obj.text || obj.content || obj.transcript || '';
        }
      } catch (_e) {
        turnText = line;
      }
    } else {
      // 2. Plain text / Markdown formats

      // Candidate timestamps & speaker labels: skip candidate statements
      // Matches: "**[00:20] You:**", "**[00:20] Você:**", "You: ...", "Você: ...", "Candidate: ..."
      if (
        /^\*{0,2}\[[\d:]+\]\s*(?:You|Você|Candidate|Me)\s*:\*{0,2}/i.test(line) ||
        /^(?:You|Você|Candidate|Me):\s*/i.test(line)
      ) {
        isInterviewer = false;
        continue;
      }

      // Check for explicit Question / Pergunta blocks in suggestions
      // Matches: '> Question: "..."', 'Question: "..."', '> Pergunta: "..."', 'Pergunta: "..."'
      const qQuoteMatch = line.match(/^(?:>\s*)?(?:Question|Pergunta|Trigger|Prompt):\s*"([^"]+)"/i);
      if (qQuoteMatch && qQuoteMatch[1]) {
        turnText = qQuoteMatch[1];
        isInterviewer = true;
        labeled = true;
      } else {
        // Interviewer timestamps & speaker labels
        // Matches: "**[00:15] Others:** ...", "**[00:15] Outros:** ...", "Interviewer: ...", "Entrevistador: ..."
        if (/^\*{0,2}\[[\d:]+\]\s*(?:Others|Outros|Interviewer|Entrevistador|Recruiter|Lead|Engineer)\s*:\*{0,2}/i.test(line)) {
          isInterviewer = true;
          labeled = true;
          turnText = line.replace(/^\*{0,2}\[[\d:]+\]\s*(?:Others|Outros|Interviewer|Entrevistador|Recruiter|Lead|Engineer)\s*:\*{0,2}\s*/i, '');
        } else if (/^(?:interviewer|entrevistador|others|outros|recruiter|lead|engineer|question|pergunta|q):\s*/i.test(line)) {
          isInterviewer = true;
          labeled = true;
          turnText = line.replace(/^(?:interviewer|entrevistador|others|outros|recruiter|lead|engineer|question|pergunta|q):\s*/i, '');
        }
      }
      // In an export, an unlabeled line is never the interviewer.
      if (isExport && !labeled) continue;
    }

    if (!isInterviewer || !turnText || turnText.trim().length < 15) continue;

    // Clean any surrounding quotation marks or markdown quote characters
    let cleanTurn = turnText.trim();
    if (cleanTurn.startsWith('>') && cleanTurn.length > 2) {
      cleanTurn = cleanTurn.replace(/^>\s*/, '').trim();
    }
    if ((cleanTurn.startsWith('"') && cleanTurn.endsWith('"')) || (cleanTurn.startsWith("'") && cleanTurn.endsWith("'"))) {
      cleanTurn = cleanTurn.slice(1, -1).trim();
    }

    // Split turn into sentences to extract discrete questions
    const sentences = cleanTurn.split(/(?<=[.?!])\s+/);
    for (const sent of sentences) {
      const val = validateQuestionWithJev(sent);
      if (val.valid && val.cleaned) {
        const cat = categorizeQuestionWithJev(val.cleaned);
        const anon = anonymizeWithJev(val.cleaned);
        candidateQuestions.push({
          text: anon,
          category: cat.category,
          subCategory: cat.subCategory
        });
      }
    }
  }

  // Deduplicate within the same session
  const seen = new Set();
  const deduped = [];
  for (const q of candidateQuestions) {
    const key = q.text.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(q);
    }
  }

  return deduped;
}

/**
 * Loads the active Question Bank, syncing dynamically with real user goals and sessions.
 */
// ---------------------------------------------------------------------------
// Generalist filter: the bank keeps questions any candidate could be asked.
// Questions about the candidate's own projects, products or past answers
// ("seu projeto da Midea", "o projeto Tech Finance", "outro exemplo") are
// specific to one person and are left out.
// ---------------------------------------------------------------------------
const PERSONAL_REF_RE = /(?<!\p{L})(?:seu|sua|seus|suas|teu|tua|your)\s+(?:próprio\s+|própria\s+)?(?:projeto|projetos|produto|aplicativo|app|startup|tcc|case|portf[oó]lio|project|product|startup)(?!\p{L})/iu;
const BACK_REF_RE = /(?<!\p{L})(?:(?:esse|este|desse|deste|nesse|neste|aquele|daquele|naquele)\s+(?:projeto|produto|caso|exemplo|aplicativo)|outro exemplo|another example|(?:o que|como|que) você (?:falou|mencionou|disse|comentou|citou)|você (?:falou|mencionou|disse|comentou|citou) que|you (?:mentioned|said))(?!\p{L})/iu;
// "projeto X" / "projeto da X" with X capitalized: a named project.
const NAMED_PROJECT_RE = /(?<!\p{L})(?:projeto|project)\s+(?:d[aoe]s?\s+|of\s+)?\p{Lu}/u;
// Tech names that show up in résumés but are generic in a question.
const GENERIC_TERMS = new Set([
  'ia', 'ai', 'sql', 'nosql', 'python', 'java', 'javascript', 'typescript', 'react', 'node', 'next', 'next.js', 'go',
  'golang', 'rust', 'kotlin', 'swift', 'c', 'c++', 'c#', 'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'git', 'github',
  'linux', 'api', 'apis', 'rest', 'graphql', 'kafka', 'redis', 'postgres', 'postgresql', 'mysql', 'mongodb', 'spark',
  'excel', 'power', 'bi', 'scrum', 'agile', 'star', 'llm', 'llms', 'ml', 'pix', 'brasil', 'brazil', 'são', 'paulo'
]);
const STOP_CAPS = new Set(['eu', 'você', 'voce', 'como', 'qual', 'quais', 'por', 'que', 'o', 'a', 'os', 'as', 'no', 'na', 'em', 'de', 'do', 'da', 'e', 'se', 'um', 'uma', 'conte', 'fale', 'descreva', 'poderia', 'the', 'how', 'what', 'why', 'tell', 'can', 'could', 'i']);

function normWord(w) {
  return String(w || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Capitalized names in the candidate's own documents (projects, employers,
// products). Target companies and generic tech words are not "personal".
function buildCandidateTerms(appDataDir) {
  const terms = new Set();
  const companies = new Set();
  const agentsDir = path.join(appDataDir || '', 'agents');
  if (!appDataDir || !fs.existsSync(agentsDir)) return { terms, companies };
  for (const f of fs.readdirSync(agentsDir).filter((x) => x.endsWith('.json'))) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(agentsDir, f), 'utf8'));
      for (const w of String(a.company || '').split(/[\s\-–—·|/]+/)) if (w.length > 2) companies.add(normWord(w));
      for (const d of a.documents || []) {
        const text = String(d.content || '').slice(0, 60000);
        for (const m of text.matchAll(/(?<!\p{L})\p{Lu}[\p{L}\p{N}]+(?:\s+\p{Lu}[\p{L}\p{N}]+)*/gu)) {
          for (const w of [m[0], m[0].replace(/\s+/g, '')]) {
            const n = normWord(w);
            if (n.length > 2 && !GENERIC_TERMS.has(n) && !STOP_CAPS.has(n)) terms.add(n);
          }
        }
      }
    } catch (_e) {}
  }
  for (const c of companies) terms.delete(c);
  return { terms, companies };
}

function isGeneralistQuestion(text, ctx = {}) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (PERSONAL_REF_RE.test(t) || BACK_REF_RE.test(t) || NAMED_PROJECT_RE.test(t)) return false;
  const terms = ctx.terms;
  if (terms && terms.size) {
    const company = normWord(ctx.company || '');
    const words = [...t.matchAll(/(?<!\p{L})\p{Lu}[\p{L}\p{N}.]*(?:\s+\p{Lu}[\p{L}\p{N}.]*)*/gu)].map((m) => m[0]);
    for (const [i, w] of words.entries()) {
      // The first word of the sentence is capitalized by grammar, not a name.
      if (i === 0 && t.trimStart().startsWith(w) && !/\s/.test(w)) continue;
      for (const cand of [w, w.replace(/\s+/g, '')]) {
        const n = normWord(cand);
        if (!n || n === company || (ctx.companies && ctx.companies.has(n)) || GENERIC_TERMS.has(n)) continue;
        if (terms.has(n)) return false;
      }
    }
  }
  return true;
}

// Bank format version: 3 = questions extracted from the session events and
// classified by JEV (the main process rebuilds an older bank once).
const QUESTION_BANK_VERSION = 3;

// What JEV calls each kind of question -> the bank's category. "especifica"
// (only makes sense for one candidate) and "nao_pergunta" are left out.
const JEV_QUESTION_TYPES = {
  pessoal: ['Behavioral', 'Pessoal e comportamental'],
  cultura: ['Culture', 'Cultura e valores'],
  motivacao: ['Culture', 'Motivação'],
  abertura: ['Opening', 'Apresentação'],
  tecnica: ['Technical', 'Técnica'],
  dominio: ['Domain knowledge', 'Negócio e produto'],
  salario: ['Salary', 'Salário e condições']
};

// Applies JEV's verdicts ({ i, tipo, pergunta }) to the extracted questions.
// A question JEV did not return keeps the rule-based reading if it is
// generalist; one JEV rejected is dropped.
function applyJevClassification(extracted, items, ctx) {
  const byIndex = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const i = Number(it && it.i);
    if (Number.isInteger(i) && i >= 0 && i < extracted.length) byIndex.set(i, it);
  }
  const out = [];
  extracted.forEach((q, i) => {
    const it = byIndex.get(i);
    if (!it) {
      if (isGeneralistQuestion(q.text, ctx)) out.push({ ...q, classifiedBy: 'regras' });
      return;
    }
    const type = JEV_QUESTION_TYPES[String(it.tipo || '').toLowerCase()];
    if (!type) return;
    const val = validateQuestionWithJev(String(it.pergunta || '').trim());
    out.push({
      text: anonymizeWithJev(val.valid ? val.cleaned : q.text),
      category: type[0],
      subCategory: type[1],
      classifiedBy: 'jev'
    });
  });
  return out;
}

function loadQuestionBank(appDataDir) {
  const bankPath = path.join(appDataDir, 'question_bank.json');
  let data = null;

  if (fs.existsSync(bankPath)) {
    try {
      data = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
    } catch (_e) {}
  }

  if (!data || !Array.isArray(data.companies)) {
    data = { version: QUESTION_BANK_VERSION, totalInterviews: 0, totalCompanies: 0, totalQuestions: 0, companies: [] };
  }

  let updated = false;

  // Only generalist questions extracted from real sessions stay; nothing is locked.
  const candidate = buildCandidateTerms(appDataDir);
  for (const comp of data.companies) {
    const before = Array.isArray(comp.questions) ? comp.questions.length : 0;
    comp.questions = (comp.questions || []).filter(
      (q) =>
        q && q.text && !SAMPLE_QUESTION_ID.test(String(q.id || '')) && !MARKUP_RE.test(q.text) &&
        isGeneralistQuestion(q.text, { ...candidate, company: comp.name })
    );
    for (const q of comp.questions) {
      if (q.locked) {
        q.locked = false;
        updated = true;
      }
    }
    if (comp.questions.length !== before) updated = true;
  }
  const withQuestions = data.companies.filter((c) => c.questions.length > 0);
  if (withQuestions.length !== data.companies.length) {
    data.companies = withQuestions;
    updated = true;
  }

  // 1. Detect active user goal company
  let activeGoalCompany = '';
  if (appDataDir) {
    const agentsDir = path.join(appDataDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      try {
        const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.json'));
        for (const af of agentFiles) {
          const aContent = JSON.parse(fs.readFileSync(path.join(agentsDir, af), 'utf8'));
          if (aContent && aContent.company) {
            const rawComp = aContent.company.replace(/\s*-\s*Estágio.*/i, '').trim();
            if (rawComp) activeGoalCompany = rawComp;
          }
        }
      } catch (_e) {}
    }
  }

  // 2. Ensure each company has domain, svg/logo and populated questions
  if (Array.isArray(data.companies)) {
    for (const comp of data.companies) {
      if (!comp.domain) {
        comp.domain = deriveDomainFromCompanyName(comp.name);
        updated = true;
      }
      if (!comp.logo) {
        const svg = getCompanySvgLogo(comp.id) || getCompanySvgLogo(comp.name);
        if (svg) {
          comp.logo = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
          updated = true;
        } else {
          comp.logo = `https://logo.clearbit.com/${comp.domain}`;
          updated = true;
        }
      }
      // Truthful question counts: questionsReported MUST equal the real array length!
      const realCount = Array.isArray(comp.questions) ? comp.questions.length : 0;
      if (comp.questionsReported !== realCount) {
        comp.questionsReported = realCount;
        updated = true;
      }
      comp.interviewsReported = Math.max(1, comp.interviewsReported || 1);
    }

    // 3. Pin active goal company (e.g. Nubank) to index 0 (top of Question Bank!)
    const targetCompName = activeGoalCompany.toLowerCase();
    const targetIdx = !targetCompName ? -1 : data.companies.findIndex(
      (c) => c.name.toLowerCase().includes(targetCompName) || c.id === targetCompName
    );
    if (targetIdx > 0) {
      const [pinned] = data.companies.splice(targetIdx, 1);
      data.companies.unshift(pinned);
      updated = true;
    }

    // 4. Truthful Bank Totals
    const realTotalQs = data.companies.reduce((sum, c) => sum + (c.questions ? c.questions.length : 0), 0);
    const realTotalCompanies = data.companies.length;
    const realTotalInterviews = data.companies.reduce((sum, c) => sum + (c.interviewsReported || 1), 0);

    if (data.totalQuestions !== realTotalQs || data.totalCompanies !== realTotalCompanies || data.totalInterviews !== realTotalInterviews) {
      data.totalQuestions = realTotalQs;
      data.totalCompanies = realTotalCompanies;
      data.totalInterviews = realTotalInterviews;
      updated = true;
    }
  }

  if (updated && appDataDir) {
    saveQuestionBank(appDataDir, data);
  }

  return data;
}

/**
 * Persists the Question Bank to appDataDir.
 */
function saveQuestionBank(appDataDir, bankData) {
  const bankPath = path.join(appDataDir, 'question_bank.json');
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.writeFileSync(bankPath, JSON.stringify(bankData, null, 2), 'utf8');
}

/**
 * Automatically ingests questions from an ended interview session into the Question Bank.
 * Automatically detects the company from the transcript and fetches/caches its real logo!
 */
// opts.exactCompany: the caller knows the company (the session's goal); skip
// guessing it from the transcript, where candidates also name past employers.
async function ingestSessionQuestions(appDataDir, transcriptText, companyName = '', opts = {}) {
  const extracted = extractQuestionsFromTranscript(transcriptText);
  if (!extracted || extracted.length === 0) {
    return { ok: true, questionsExtracted: 0, added: 0 };
  }

  // 1. Detect company from transcript text
  const detection = opts.exactCompany && companyName
    ? detectCompanyFromTranscript('', companyName)
    : detectCompanyFromTranscript(transcriptText, companyName);
  const cleanName = detection.name;
  const compId = detection.id;

  // 2. Fetch / resolve company logo
  let logoInfo = { logoUrl: '', domain: detection.domain };
  try {
    logoInfo = await resolveAndCacheCompanyLogo(appDataDir, cleanName, detection.domain);
  } catch (_e) {
    const svg = getCompanySvgLogo(compId) || getCompanySvgLogo(cleanName);
    logoInfo.logoUrl = svg ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` : '';
  }

  const bank = loadQuestionBank(appDataDir);
  let company = bank.companies.find((c) => c.id === compId || c.name.toLowerCase() === cleanName.toLowerCase());

  if (!company) {
    company = {
      id: compId,
      name: cleanName,
      domain: logoInfo.domain || `${compId}.com`,
      logo: logoInfo.logoUrl,
      monogram: cleanName.slice(0, 3).toUpperCase(),
      interviewsReported: 1,
      questionsReported: 0,
      lastInterviewReported: 'Today',
      categories: { Technical: 0, 'Domain knowledge': 0, Behavioral: 0 },
      subCategories: { Coding: 0, 'System design': 0 },
      unlocked: false,
      unlockedTop3: false,
      questions: []
    };
    bank.companies.unshift(company); // Newly detected company appears at top!
    bank.totalCompanies = (bank.totalCompanies || 0) + 1;
  } else {
    company.interviewsReported = (company.interviewsReported || 0) + 1;
    company.lastInterviewReported = 'Today';
    if (!company.logo || company.logo.includes('clearbit')) {
      company.logo = logoInfo.logoUrl;
    }
  }

  let addedCount = 0;
  const candidate = buildCandidateTerms(appDataDir);
  const ctx = { ...candidate, company: company.name };
  // opts.classify(texts, { company }) -> [{ i, tipo, pergunta }] | null: JEV
  // reads each question (kind, generic wording, whether it belongs in a bank).
  // Without it, or when it fails, the rule-based reading stands.
  let verdicts = null;
  if (typeof opts.classify === 'function') {
    try {
      verdicts = await opts.classify(extracted.map((q) => q.text), { company: company.name });
    } catch (_e) {
      verdicts = null;
    }
  }
  const accepted = verdicts
    ? applyJevClassification(extracted, verdicts, ctx)
    : extracted.filter((q) => isGeneralistQuestion(q.text, ctx)).map((q) => ({ ...q, classifiedBy: 'regras' }));
  for (const q of accepted) {
    company.categories[q.category] = (company.categories[q.category] || 0) + 1;
    if (q.subCategory && company.subCategories[q.subCategory] !== undefined) {
      company.subCategories[q.subCategory] = (company.subCategories[q.subCategory] || 0) + 1;
    }

    const existingQ = (company.questions || []).find((eq) =>
      eq.text.toLowerCase().replace(/[^a-z0-9]/g, '') === q.text.toLowerCase().replace(/[^a-z0-9]/g, '')
    );

    if (existingQ) {
      existingQ.interviewsCount = (existingQ.interviewsCount || 1) + 1;
      existingQ.lastReported = 'Today';
      if (q.classifiedBy === 'jev') {
        existingQ.category = q.category;
        existingQ.subCategory = q.subCategory;
        existingQ.classifiedBy = 'jev';
      }
    } else {
      if (!company.questions) company.questions = [];
      company.questions.unshift({
        id: `${company.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: q.text,
        category: q.category,
        subCategory: q.subCategory,
        classifiedBy: q.classifiedBy,
        interviewsCount: 1,
        lastReported: 'Today',
        locked: false
      });
      company.questionsReported = (company.questionsReported || 0) + 1;
      bank.totalQuestions = (bank.totalQuestions || 0) + 1;
      addedCount++;
    }
  }

  bank.totalInterviews = (bank.totalInterviews || 0) + 1;
  saveQuestionBank(appDataDir, bank);

  return {
    ok: true,
    company: company.name,
    detectedCompany: detection,
    domain: company.domain,
    logo: company.logo,
    questionsExtracted: accepted.length,
    added: addedCount,
    questions: accepted
  };
}

/**
 * Rebuilds the bank from scratch out of real session transcripts.
 * entries: [{ text, company }] (text in any format extractQuestionsFromTranscript reads).
 */
// opts.classify: see ingestSessionQuestions.
async function rebuildQuestionBank(appDataDir, entries, opts = {}) {
  saveQuestionBank(appDataDir, { version: QUESTION_BANK_VERSION, totalInterviews: 0, totalCompanies: 0, totalQuestions: 0, companies: [] });
  let added = 0;
  for (const e of entries || []) {
    if (!e || !e.text) continue;
    try {
      const r = await ingestSessionQuestions(appDataDir, e.text, e.company || '', { exactCompany: Boolean(e.company), classify: opts.classify });
      added += (r && r.added) || 0;
    } catch (_e) {}
  }
  return { ok: true, added, bank: loadQuestionBank(appDataDir) };
}

/**
 * Unlocks top 3 preview or full company questions.
 */
function unlockCompany(appDataDir, companyId, previewOnly = true) {
  const bank = loadQuestionBank(appDataDir);
  const company = bank.companies.find((c) => c.id === companyId);
  if (!company) return { ok: false, error: 'Company not found' };

  if (previewOnly) {
    company.unlockedTop3 = true;
    (company.questions || []).slice(0, 3).forEach((q) => {
      q.locked = false;
    });
  } else {
    company.unlocked = true;
    company.unlockedTop3 = true;
    (company.questions || []).forEach((q) => {
      q.locked = false;
    });
  }

  saveQuestionBank(appDataDir, bank);
  return { ok: true, company };
}

module.exports = {
  QUESTION_BANK_VERSION,
  JEV_QUESTION_TYPES,
  applyJevClassification,
  KNOWN_COMPANIES,
  detectCompanyFromTranscript,
  validateQuestionWithJev,
  categorizeQuestionWithJev,
  anonymizeWithJev,
  extractQuestionsFromTranscript,
  loadQuestionBank,
  saveQuestionBank,
  ingestSessionQuestions,
  rebuildQuestionBank,
  isGeneralistQuestion,
  buildCandidateTerms,
  unlockCompany
};
