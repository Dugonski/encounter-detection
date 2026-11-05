# Detecção de Encontros: Desafio Trainee Tech Spacecom 2027

Detecta encontros (`generico`, `faccao`, `protetiva`) entre monitorados a partir de dados de geolocalização. Um encontro acontece quando duas pessoas estão a **menos de 20 m** (Haversine, R = 6.371.000 m) **no mesmo timestamp**.

## Como executar

Requisitos: Node.js 18+ (testado no Node 24). Copie `dataset1.txt` … `dataset7.txt` para a raiz do projeto.

```bash
npm install
npm run build
node dist/src/index.js dataset7.txt        # gera output/respostas7.json
```

Para os 7 datasets:

```bash
for n in 1 2 3 4 5 6 7; do node dist/src/index.js dataset$n.txt; done   # bash
1..7 | ForEach-Object { node dist/src/index.js "dataset$_.txt" }         # PowerShell
```

Opções: `[saida.json]` define o arquivo de saída, `--threads=N` ou `--sequential` controlam o paralelismo, e `--baseline` usa a implementação simples de referência. Os JSONs gerados para os 7 datasets estão em `output/`.

## Lógica utilizada

**Algoritmo:** processamento em *streaming* de passada única, agrupado por timestamp. A busca de pares usa um **sweep line por latitude** (ordenação incremental com *insertion sort* + janela de 20 m), e só os candidatos passam pela fórmula de **Haversine**. Nos arquivos grandes, o trabalho é dividido entre núcleos no modelo **map-reduce com `worker_threads`**: cada worker detecta os encontros da sua faixa do arquivo, e a thread principal junta os resultados.

**Arquitetura:** um pipeline de etapas, cada uma em um módulo:

```
leitura em blocos ─► parsing de bytes ─► agrupamento por timestamp ─► sweep + Haversine ─► classificação ─► JSON
   (engine.ts)          (engine.ts)            (engine.ts)                (engine.ts, geo.ts)                  (output.ts)
        └──────────── uma faixa do arquivo por worker (parallel.ts) ────────────┘
```

O enunciado manda comparar apenas posições do mesmo timestamp, e os arquivos vêm ordenados por timestamp. Então o programa lê o arquivo **um timestamp por vez**, detecta os encontros daquele grupo e o descarta. Com no máximo 120 pessoas por timestamp, comparar pares é barato; o custo está em ler até 640 MB de texto. Por isso a solução tem quatro partes:

1. **Leitura em blocos e parsing de bytes.** O arquivo é lido em blocos de 8 MB e cada linha é interpretada direto do `Buffer`, sem `split` nem strings por linha. As coordenadas viram número como inteiro ÷ 10^casas (ex.: `-2559386 / 100000`), o que dá exatamente o mesmo valor que `parseFloat`. As posições ficam em typed arrays reutilizados, e a memória fica constante.

2. **Busca de pares por latitude.** Em cada timestamp, os pontos são ordenados por latitude (reaproveitando a ordem do timestamp anterior, que quase não muda). Cada ponto é comparado apenas com os seguintes enquanto a diferença de latitude for menor que 20 m. Isso não perde nenhum encontro, porque a distância real é sempre ≥ R·|Δlatitude|. Só os pares candidatos passam pelo Haversine.

3. **Classificação.** `protetiva` se um dos dois tem o id do outro em `idsRestricaoMedida`; `faccao` se têm a mesma facção (não vazia); `generico` nos demais casos. A saída é ordenada por timestamp, com ids em ordem crescente.

4. **Paralelismo nos arquivos grandes (≥ 128 MB).** O arquivo é dividido em uma faixa por núcleo, e cada corte é movido para o início de um timestamp novo, de modo que nenhum grupo fica dividido. Cada `worker_thread` processa sua faixa com o mesmo código, e os resultados são concatenados em ordem. Em arquivos menores, iniciar workers custa mais do que economiza.

Detalhe de precisão: a conversão para radianos é `deg * Math.PI / 180`. Pré-calcular `Math.PI / 180` muda o último dígito da distância em relação ao gabarito.

## Por que esta abordagem

- **Correta.** A saída é idêntica byte a byte aos gabaritos dos datasets 1 e 2, sem falsos positivos. Nos datasets 3 a 7, ela é idêntica à de uma implementação simples que compara todos os pares, mantida no projeto como referência.
- **Otimiza o que realmente custa.** Medições mostraram que o gargalo é ler e interpretar o texto, não a geometria. Ler bytes em vez de strings levou os 7 datasets de ~277 s para ~7,7 s, e o paralelismo, para **~5,3 s** (dataset 7: ~2,1 s). Estruturas espaciais como quadtree ou geohash pouco ajudariam com 120 pontos por timestamp.
- **Simples de justificar.** Não há dependências externas. A busca de pares se apoia em uma desigualdade geométrica, não em heurística, e o paralelismo só é usado onde a medição mostrou ganho.
- **Premissa explícita.** A solução supõe que o arquivo esteja ordenado por timestamp, o que foi verificado nos 7 datasets. Isso permite memória constante e a divisão para o paralelismo. Para uma entrada fora de ordem, bastaria agrupar as posições por timestamp antes da detecção.
