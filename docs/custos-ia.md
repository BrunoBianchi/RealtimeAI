# Custo de IA por sessão no LipCue

Preços consultados em 7 de novembro de 2026, em dólares americanos. O GPT-6 Astra é a referência premium para texto, código e imagens. Ele é o modelo mais capaz segundo a OpenAI e usa serviços separados para transcrição e voz. A comparação com os modelos configurados no LipCue usa Qwen3.6 Flash para texto, código e JEV e GPT-5.4 mini para câmera. [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) · [Qwen3.6 Flash](https://openrouter.ai/qwen/qwen3.6-flash) · [GPT-5.4 mini](https://openrouter.ai/openai/gpt-5.4-mini)

| Fluxo | Unidade | Configuração padrão | Referência GPT-6 Astra |
| --- | --- | ---: | ---: |
| Simulado Básico | 30 min | US$ 0,02 | US$ 1,11 |
| Simulado Avançado | 30 min com voz e câmera | US$ 0,52 a 0,72 | US$ 1,87 a 2,07 |
| Pair Programming com IA | Um exercício | US$ 0,01 | US$ 0,57 |
| Entrevista ao vivo | 30 min com dois canais | US$ 0,59 | US$ 2,30 |

## Amostra local

Três simulados Avançados duraram em média 6,8 min, com 7 respostas do Orby, 1.061 caracteres de voz e 3,3 análises visuais. Entre 29 sessões ao vivo com duração registrada de pelo menos um minuto, a média foi de 6,3 min e 5,2 sugestões. A amostra contém cinco exercícios de Pair Programming, três com avaliação e sem contagem persistida de interações. O histórico consultado tinha zero simulados Básicos. Os valores da tabela são projeções de consumo em cenários padronizados, sem faturas ou contagem de tokens cobrados por sessão.

Aplicando as tarifas do cenário premium ao volume observado e reservando um lote de JEV mais a síntese nas sessões curtas, o custo projetado é de US$ 0,52 a 0,56 no Avançado e cerca de US$ 0,52 ao vivo. Para o ao vivo, essa conta inclui dois canais de áudio e uma classificação curta de perguntas.

## Cálculo

O custo do modelo é a soma de tokens de entrada e saída multiplicados pelas respectivas tarifas. Por milhão de tokens, as tarifas de entrada e saída são US$ 10 e US$ 50 para Astra, US$ 0,1875 e US$ 1,125 para Qwen e US$ 0,75 e US$ 4,50 para GPT-5.4 mini. O Nova-3 multilíngue custa US$ 0,0092 por minuto de áudio por canal. Para voz, a página exibe US$ 40 por milhão de caracteres junto de um aviso de desconto com data vencida. A faixa usa o preço exibido e o dobro dele como cenário de sensibilidade. [Tarifas do Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) · [Deepgram](https://deepgram.com/pricing) · [Eleven Turbo v2.5](https://openrouter.ai/elevenlabs/eleven-turbo-v2.5)

| Etapa | Consumo no cenário | Custo com Astra e os serviços de áudio |
| --- | --- | ---: |
| Conversa nos simulados | 20 respostas, 3.600 tokens de entrada e 160 de saída por resposta | US$ 0,880 |
| JEV dos simulados | 3 lotes de até 5 respostas, 2.500/750 tokens por lote, e uma síntese de 2.000/350 | US$ 0,225 |
| Transcrição do Avançado | 30 min, um canal | US$ 0,276 |
| Voz do Avançado | 5.000 caracteres sintetizados | US$ 0,200 a 0,400 |
| Câmera do Avançado | 30 chamadas, 59 imagens de 512 × 288, mais 180 tokens de texto de entrada e 90 de saída por chamada | US$ 0,291 |
| Conversa no Pair Programming | 12 interações, incluindo abertura e análise dos testes, a 3.500/120 tokens | US$ 0,492 |
| Avaliação do Pair Programming | Uma avaliação de 4.500/700 tokens | US$ 0,080 |
| Transcrição ao vivo | 30 min, microfone e áudio do sistema | US$ 0,552 |
| Sugestões ao vivo | 25 respostas a 4.000/250 tokens | US$ 1,313 |
| Memória da conversa ao vivo | 2 compactações a 2.000/250 tokens | US$ 0,065 |
| JEV ao vivo | 4 lotes a 2.500/750 tokens e uma síntese de 2.500/350 | US$ 0,293 |
| Classificação de perguntas ao vivo | Uma chamada de 3.000/1.000 tokens | US$ 0,080 |

Os tokens de entrada das sugestões incluem o contexto enviado a cada chamada. Cada imagem do cenário representa aproximadamente 173 tokens de entrada. A câmera é opcional. A execução de código e dos testes de Pair Programming é local. [Cálculo de tokens de imagem](https://developers.openai.com/api/docs/guides/images-vision#calculating-costs)

O cenário ao vivo com GPT-6.1 Sol no texto, a US$ 2 de entrada e US$ 10 de saída por milhão de tokens, custa cerca de US$ 0,90 com a mesma transcrição. A latência e a qualidade comparativa no LipCue precisariam ser medidas em sessões equivalentes. [GPT-6.1 Sol](https://openrouter.ai/openai/gpt-6.1-sol)

Cada pergunta adicional ao coach pós-simulado acrescenta aproximadamente US$ 0,07 com Astra para 5.000 tokens de entrada e 400 de saída. O relatório textual do debrief ao vivo tem processamento local, com a classificação de perguntas já representada na tabela. OCR de PDFs digitalizados, preparação de dossiês, novas avaliações, tentativas extras, raciocínio adicional, infraestrutura e impostos ficam fora do cenário. Descontos por cache também ficam fora. [OCR no OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/pdfs)

Um pedido extra de resumo ou próximos passos durante o ao vivo custa cerca de US$ 0,07 com os mesmos 5.000/400 tokens. Uma análise adicional de captura de tela de 1.280 × 720, com 4.000 tokens de contexto e 250 de resposta, custa aproximadamente US$ 0,064. A quantidade de chamadas iniciadas e descartadas pelo mecanismo que antecipa perguntas também pode elevar a fatura. [Cálculo de tokens de imagem](https://developers.openai.com/api/docs/guides/images-vision#calculating-costs)

## Saldo dos simulados

Os tokens do LipCue são unidades de cobrança por sessão. O Básico usa 24 e o Avançado usa 48 do mesmo saldo. A proporção de dois para um arredonda a diferença de custo do cenário premium. O Pro inclui 72 tokens por ciclo, equivalentes a um Básico e um Avançado, com liberdade para combinar os modos. Créditos antigos convertem pelo valor do modo de origem. Pair Programming e ao vivo entram no estudo de custos e seguem as respectivas regras de acesso.
