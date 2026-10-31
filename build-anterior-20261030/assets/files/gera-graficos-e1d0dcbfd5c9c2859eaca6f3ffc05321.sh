#!/bin/bash

# =============================================================================
#  gera-graficos.sh · gráficos da comparação das 3 configurações (issue #39)
# =============================================================================
#
#  Lê comparacao-3-configuracoes.csv (a planilha de números, uma linha por valor e a
#  `fonte` de cada um, nos README das etapas de Projeto/carga/results e no artigo) e
#  grava dois SVGs autocontidos, sem lib externa, na pasta de saída:
#
#    x-sequencial.svg       limiar X (RPM por evento) da escada SEQUENCIAL, uma série
#                           (barras horizontais). O 04b (cabo) é só limite inferior
#                           (X >= 60k): contorno tracejado com seta, não barra sólida. O teto do
#                           host da Rodada R (intercalado, 86k) fica fora da série, separado e
#                           rotulado "não comparável".
#    latencia-aleatorio.svg reserva e confirmação (p50, p95, p99) do aleatório de 45 min, mesma
#                           semente 617706, em dois painéis de mesma escala (small multiples,
#                           nunca eixo duplo). O 04b não tem aleatório.
#
#  Overselling e lag NÃO viram gráfico: são tabelas (o lag tem unidade e definição diferentes
#  por ponto). Os valores plotados vêm do CSV e o script não calcula nenhum número; só a semente
#  (617706), a baseline do Wi-Fi (26,6 / 42,9 ms) e a escala fixa de 0 a 70 ms do gráfico de latência
#  estão escritas no script (os dois primeiros, nos textos do SVG).
#
#  Premissa do CSV: o script separa por vírgula simples e só lê as colunas 1 a 3 e 5 das linhas usadas
#  (x_seq*, x_intercalado*, reserva_* e confirma_*). Essas linhas não podem ter vírgula em `valor` nem em
#  `fonte` (as demais linhas, como lag e rede, podem, entre aspas: ficam depois e não são lidas).
#
#  Uso:  gera-graficos.sh [comparacao-3-configuracoes.csv] [pasta-de-saida]
#        (sem argumentos: o CSV ao lado do script e a própria pasta do script)
#  Roda em qualquer bash com awk (o Git Bash serve). Os SVGs ficam versionados.
#
#  Cores: mesmos tokens do report-degraus.sh (docs/carga/harness), paleta validada com a skill
#  dataviz (validate_palette.js, séries 1..3, modos claro e escuro: todas as checagens passam; o
#  verde-água no claro fica abaixo de 3:1 de contraste, compensado por legenda, rótulo direto do
#  p99, tooltip e pela tabela do artigo). O tema vem de @media (prefers-color-scheme: dark) no
#  <style> do próprio SVG.
# =============================================================================

set -uo pipefail
export LC_ALL=C   # ponto decimal no printf do awk, independente do locale

AQUI="$(cd "$(dirname "$0")" && pwd)"
CSV="${1:-$AQUI/comparacao-3-configuracoes.csv}"
OUT="${2:-$AQUI}"
[ -f "$CSV" ] || { echo "ERRO: arquivo não encontrado: $CSV" >&2; exit 1; }
mkdir -p "$OUT"

awk -v out="$OUT" '
BEGIN { FS = ","; erro = 0 }

function esc(s) { gsub(/&/, "\\&amp;", s); gsub(/</, "\\&lt;", s); gsub(/>/, "\\&gt;", s); gsub(/"/, "\\&quot;", s); return s }
function vir(s) { gsub(/\./, ",", s); return s }                       # 3.9 -> 3,9 (como o artigo)
function kfmt(v) { return sprintf("%dk", v / 1000) }
function need(k) { if (!(k in V)) { printf "ERRO: linha ausente no CSV: %s\n", k > "/dev/stderr"; erro = 1 } }

# retângulo com os cantos do lado do dado arredondados (r = 4): barra horizontal, base em x0
function barH(x0, y, w, h, r) {
    return sprintf("M%.1f %.1f H%.1f a%d %d 0 0 1 %d %d V%.1f a%d %d 0 0 1 -%d %d H%.1f Z", x0, y, x0 + w - r, r, r, r, r, y + h - r, r, r, r, r, x0)
}
# barra vertical, base em y1 (linha de base), topo arredondado
function barV(x, ytop, w, y1, r) {
    return sprintf("M%.1f %.1f V%.1f a%d %d 0 0 1 %d -%d H%.1f a%d %d 0 0 1 %d %d V%.1f Z", x, y1, ytop + r, r, r, r, r, x + w - r, r, r, r, r, y1)
}

function estilo() {
    return "<style>\n" \
    "  :root { --surface-1:#fcfcfb; --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#898781; --grid:#e1e0d9; --baseline:#c3c2b7; --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a; }\n" \
    "  @media (prefers-color-scheme: dark) {\n" \
    "    :root { --surface-1:#1a1a19; --text-primary:#ffffff; --text-secondary:#c3c2b7; --grid:#2c2c2a; --baseline:#383835; --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; }\n" \
    "  }\n" \
    "  text { font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif; font-variant-numeric: tabular-nums; }\n" \
    "  .bg { fill: var(--surface-1); }\n" \
    "  .titulo { fill: var(--text-primary); font-size: 16px; font-weight: 600; }\n" \
    "  .sub { fill: var(--text-secondary); font-size: 12px; }\n" \
    "  .tp { fill: var(--text-primary); font-size: 13px; }\n" \
    "  .ts { fill: var(--text-secondary); font-size: 12px; }\n" \
    "  .tm { fill: var(--text-muted); font-size: 11px; }\n" \
    "  .val { fill: var(--text-primary); font-size: 13px; font-weight: 600; }\n" \
    "  .grid { stroke: var(--grid); stroke-width: 1; }\n" \
    "  .base { stroke: var(--baseline); stroke-width: 1; }\n" \
    "  .s1 { fill: var(--series-1); } .s2 { fill: var(--series-2); } .s3 { fill: var(--series-3); }\n" \
    "  .oco { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-dasharray: 5 3; }\n" \
    "  .seta { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }\n" \
    "  .teto { fill: none; stroke: var(--text-secondary); stroke-width: 2; }\n" \
    "  .div { stroke: var(--baseline); stroke-width: 1; stroke-dasharray: 3 4; }\n" \
    "  .hit { fill: transparent; pointer-events: all; }\n" \
    "</style>\n"
}

# ------------------------------------------------------------------ x-sequencial.svg
function grafico_x(   W, H, pL, pw, i, yc, h, x, v, tip, y1) {
    W = 900; H = 470; pL = 250; pw = 420; h = 18
    f = out "/x-sequencial.svg"
    printf "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 %d %d\" width=\"100%%\" role=\"img\" aria-label=\"Limiar X da escada sequencial por configuração, em reservas por minuto por evento: %s\">\n", W, H, \
        "pré-pooler " kfmt(V["x_seq|P0-pre-pooler-ref"]) ", ponto 1 " kfmt(V["x_seq|P1-crud-pooler-03"]) ", ponto 2 no Wi-Fi " kfmt(V["x_seq|P2-es-wifi-04"]) ", ponto 2 no cabo no mínimo " kfmt(V["x_seq_piso|P2-es-cabo-04b"]) ", ponto 3 intermediário " kfmt(V["x_seq|P3-intermediario-05"]) ", rodada final " kfmt(V["x_seq|R-final-06"]) > f
    printf "<title>Limiar X da escada sequencial por configuração</title>\n<desc>Barras horizontais, uma série, em reservas por minuto por evento. O ponto 2 no cabo é só limite inferior. O teto do host intercalado da rodada final fica fora da série.</desc>\n" > f
    printf "%s<rect class=\"bg\" width=\"%d\" height=\"%d\"/>\n", estilo(), W, H > f
    printf "<text class=\"titulo\" x=\"16\" y=\"26\">Limiar X por configuração (escada sequencial)</text>\n" > f
    printf "<text class=\"sub\" x=\"16\" y=\"45\">Reservas por minuto numa única linha do eventcap, braço CAS. Uma escada por configuração.</text>\n" > f

    # linhas: chave, rótulo, subrótulo, anotação depois do valor
    n = 6
    key[1] = "x_seq|P0-pre-pooler-ref";      rot[1] = "Pré-pooler (02)";   sub_[1] = "monólito + HikariCP · referência"; ano[1] = ""
    key[2] = "x_seq|P1-crud-pooler-03";      rot[2] = "Ponto 1 (03)";      sub_[2] = "monólito CRUD + pooler";          ano[2] = ""
    key[3] = "x_seq|P2-es-wifi-04";          rot[3] = "Ponto 2 (04)";      sub_[3] = "monólito ES · Wi-Fi";             ano[3] = " · Wi-Fi"
    key[4] = "x_seq_piso|P2-es-cabo-04b";    rot[4] = "Ponto 2 (04b)";     sub_[4] = "monólito ES · cabo";              ano[4] = " · limite inferior"
    key[5] = "x_seq|P3-intermediario-05";    rot[5] = "Ponto 3 (05)";      sub_[5] = "distribuído intermediário";       ano[5] = ""
    key[6] = "x_seq|R-final-06";             rot[6] = "Final (06)";        sub_[6] = "distribuído · Rodada R";          ano[6] = " · último limpo " kfmt(V["x_seq_ultimo_limpo|R-final-06"])

    y1 = 400
    # grade vertical + eixo x (0 a 100k, de 20k em 20k)
    for (i = 0; i <= 5; i++) {
        x = pL + (i * 20000) / 100000 * pw
        printf "<line class=\"%s\" x1=\"%.1f\" y1=\"66\" x2=\"%.1f\" y2=\"%d\"/>\n", (i == 0 ? "base" : "grid"), x, x, y1 > f
        printf "<text class=\"tm\" x=\"%.1f\" y=\"%d\" text-anchor=\"middle\">%s</text>\n", x, y1 + 16, (i == 0 ? "0" : kfmt(i * 20000)) > f
    }
    printf "<text class=\"tm\" x=\"%.1f\" y=\"%d\" text-anchor=\"middle\">RPM por evento (reservas/min) · escala linear</text>\n", pL + pw / 2, y1 + 36 > f

    for (i = 1; i <= n; i++) {
        v = V[key[i]]
        yc = 82 + (i - 1) * 46
        x = v / 100000 * pw
        tip = sprintf("%s · %s: X %s%s RPM · fonte: %s", rot[i], sub_[i], (i == 4 ? "≥ " : ""), kfmt(v), F[key[i]])
        if (i == 6) tip = tip sprintf(" · último degrau limpo %s", kfmt(V["x_seq_ultimo_limpo|R-final-06"]))
        printf "<g><title>%s</title><rect class=\"hit\" x=\"0\" y=\"%.1f\" width=\"%d\" height=\"44\"/>\n", esc(tip), yc - 22, W > f
        printf "<text class=\"tp\" x=\"16\" y=\"%.1f\">%s</text><text class=\"tm\" x=\"16\" y=\"%.1f\">%s</text>\n", yc - 2, esc(rot[i]), yc + 13, esc(sub_[i]) > f
        if (i == 4) {
            # limite inferior: contorno tracejado até o piso e seta para a direita (não é barra sólida)
            printf "<rect class=\"oco\" x=\"%.1f\" y=\"%.1f\" width=\"%.1f\" height=\"%d\" rx=\"4\"/>\n", pL + 1, yc - h / 2, x - 1, h > f
            printf "<path class=\"seta\" d=\"M%.1f %.1f H%.1f M%.1f %.1f L%.1f %.1f L%.1f %.1f\"/>\n", pL + x + 3, yc, pL + x + 22, pL + x + 16, yc - 5, pL + x + 22, yc, pL + x + 16, yc + 5 > f
            printf "<text class=\"val\" x=\"%.1f\" y=\"%.1f\">≥ %s<tspan class=\"ts\" font-weight=\"400\">%s</tspan></text>\n", pL + x + 30, yc + 5, kfmt(v), esc(ano[i]) > f
        } else {
            printf "<path class=\"s1\" d=\"%s\"/>\n", barH(pL, yc - h / 2, x, h, 4) > f
            printf "<text class=\"val\" x=\"%.1f\" y=\"%.1f\">%s<tspan class=\"ts\" font-weight=\"400\">%s</tspan></text>\n", pL + x + 8, yc + 5, kfmt(v), esc(ano[i]) > f
        }
        printf "</g>\n" > f
    }

    # fora da série: teto do host (intercalado) como losango, separado e rotulado
    printf "<line class=\"div\" x1=\"16\" y1=\"350\" x2=\"%d\" y2=\"350\"/>\n", W - 16 > f
    printf "<text class=\"tm\" x=\"16\" y=\"366\">Fora da série · não comparável com o X sequencial</text>\n" > f
    v = V["x_intercalado|R-final-06"]
    yc = 384
    x = v / 100000 * pw
    tip = sprintf("Final (06), mapeamento intercalado: %s RPM (teto do host somado entre eventos, não é X por evento; não comparável com o X sequencial) · último degrau limpo %s · fonte: %s", kfmt(v), kfmt(V["x_intercalado_ultimo_limpo|R-final-06"]), F["x_intercalado|R-final-06"])
    printf "<g><title>%s</title><rect class=\"hit\" x=\"0\" y=\"%.1f\" width=\"%d\" height=\"26\"/>\n", esc(tip), yc - 13, W > f
    printf "<text class=\"tp\" x=\"16\" y=\"%.1f\">Final (06) · intercalado</text>\n", yc + 4 > f
    printf "<path class=\"teto\" d=\"M%.1f %.1f l7 7 l-7 7 l-7 -7 Z\"/>\n", pL + x, yc - 7 > f
    printf "<text class=\"val\" x=\"%.1f\" y=\"%.1f\">%s<tspan class=\"ts\" font-weight=\"400\"> · teto do host</tspan></text>\n", pL + x + 14, yc + 5, kfmt(v) > f
    printf "</g>\n</svg>\n" > f
    close(f)
}

# ------------------------------------------------------------------ latencia-aleatorio.svg
function painel(ox, tit, met,   pL, pR, ytop, ybase, top, gw, bw, i, g, s, a, x, gx, hgt, y, v, tip) {
    pL = ox; pR = ox + 368; ytop = 108; ybase = 308; top = 70
    gw = 92; bw = 20
    printf "<text class=\"tp\" x=\"%d\" y=\"92\" font-weight=\"600\">%s</text>\n", ox, tit > f
    # grade horizontal: 0, 20, 40, 60 ms (mesma escala nos dois painéis)
    for (i = 0; i <= 3; i++) {
        y = ybase - (i * 20) / top * (ybase - ytop)
        printf "<line class=\"%s\" x1=\"%d\" y1=\"%.1f\" x2=\"%d\" y2=\"%.1f\"/>\n", (i == 0 ? "base" : "grid"), pL, y, pR, y > f
        printf "<text class=\"tm\" x=\"%d\" y=\"%.1f\" text-anchor=\"end\">%d</text>\n", pL - 8, y + 4, i * 20 > f
    }
    for (g = 1; g <= 4; g++) {
        split(LAT[met, g], a, "/")
        gx = pL + (g - 1) * gw
        printf "<text class=\"tp\" x=\"%.1f\" y=\"%d\" text-anchor=\"middle\">%s</text><text class=\"tm\" x=\"%.1f\" y=\"%d\" text-anchor=\"middle\">%s</text>\n", gx + gw / 2, ybase + 18, esc(GR[g]), gx + gw / 2, ybase + 33, esc(GS[g]) > f
        for (s = 1; s <= 3; s++) {
            v = a[s] + 0
            hgt = v / top * (ybase - ytop)
            x = gx + 13 + (s - 1) * (bw + 3)
            tip = sprintf("%s · %s · %s · %s ms · aleatório de 45 min, semente 617706 · fonte: %s", tit, GR[g] " (" GN[g] ")", PCT[s], vir(a[s]), LF[met, g])
            printf "<g><title>%s</title><path class=\"s%d\" d=\"%s\"/>", esc(tip), s, barV(x, ybase - hgt, bw, ybase, 3) > f
            if (s == 3) printf "<text class=\"val\" x=\"%.1f\" y=\"%.1f\" text-anchor=\"middle\" style=\"font-size:11px\">%s%s</text>", x + bw / 2, ybase - hgt - 5, vir(a[s]), (g == 2 ? " (Wi-Fi)" : "") > f
            printf "</g>\n" > f
        }
    }
}

function grafico_lat(   W, H, i) {
    W = 880; H = 400
    f = out "/latencia-aleatorio.svg"
    printf "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 %d %d\" width=\"100%%\" role=\"img\" aria-label=\"Latência de reserva e de confirmação (p50, p95 e p99, em ms) no aleatório de 45 minutos, mesma semente, em quatro configurações: ponto 1, ponto 2 no Wi-Fi, ponto 3 intermediário e rodada final. O ponto 2 foi medido no Wi-Fi; a latência dele inclui a rede.\">\n", W, H > f
    printf "<title>Latência do aleatório de 45 min por configuração</title>\n<desc>Dois painéis de mesma escala (reserva e confirmação), barras agrupadas por configuração com p50, p95 e p99 em milissegundos. O ponto 2 foi medido no Wi-Fi; o 04b (cabo) não tem aleatório.</desc>\n" > f
    printf "%s<rect class=\"bg\" width=\"%d\" height=\"%d\"/>\n", estilo(), W, H > f
    printf "<text class=\"titulo\" x=\"16\" y=\"26\">Latência no aleatório de 45 min (ms)</text>\n" > f
    printf "<text class=\"sub\" x=\"16\" y=\"45\">Mesma semente (617706) nas quatro configurações. Os dois painéis têm a mesma escala.</text>\n" > f
    # legenda: ordem fixa p50, p95, p99 = séries 1, 2, 3
    for (i = 1; i <= 3; i++) {
        printf "<rect class=\"s%d\" x=\"%d\" y=\"58\" width=\"12\" height=\"12\" rx=\"2\"/><text class=\"ts\" x=\"%d\" y=\"69\">%s</text>\n", i, 56 + (i - 1) * 56, 56 + (i - 1) * 56 + 18, PCT[i] > f
    }
    painel(56, "Reserva", "reserva")
    painel(480, "Confirmação", "confirma")
    printf "<text class=\"tm\" x=\"16\" y=\"%d\">O ponto 2 foi medido no Wi-Fi (baseline HTTP p50 26,6 / p95 42,9 ms): a latência dele inclui a rede. Sem aleatório no 04b (cabo).</text>\n", H - 22 > f
    printf "<text class=\"tm\" x=\"16\" y=\"%d\">Rótulo = p99. Os demais valores estão na tabela do artigo e no tooltip de cada barra.</text>\n", H - 8 > f
    printf "</svg>\n" > f
    close(f)
}

{ sub(/\r$/, ""); if (NR == 1) sub(/^\357\273\277/, "") }
NR == 1 { next }
/^[ \t]*$/ { next }
{
    k = $1 "|" $2
    V[k] = $3
    F[k] = $5
    # linhas do aleatório: o nome da configuração leva a semente (Ale-NNNNN)
    if ($1 == "reserva_p50_p95_p99" || $1 == "confirma_p50_p95_p99") {
        met = ($1 == "reserva_p50_p95_p99") ? "reserva" : "confirma"
        g = 0
        if ($2 ~ /Ale-29057/) g = 1; else if ($2 ~ /Ale-190276/) g = 2; else if ($2 ~ /Ale-644172/) g = 3; else if ($2 ~ /Ale-939580/) g = 4
        if (g) { LAT[met, g] = $3; LF[met, g] = $5; GN[g] = $2 }
    }
}

END {
    need("x_seq|P0-pre-pooler-ref"); need("x_seq|P1-crud-pooler-03"); need("x_seq|P2-es-wifi-04")
    need("x_seq_piso|P2-es-cabo-04b"); need("x_seq|P3-intermediario-05"); need("x_seq|R-final-06")
    need("x_seq_ultimo_limpo|R-final-06"); need("x_intercalado|R-final-06"); need("x_intercalado_ultimo_limpo|R-final-06")
    for (g = 1; g <= 4; g++) { if (!(("reserva", g) in LAT)) { printf "ERRO: reserva ausente (config %d)\n", g > "/dev/stderr"; erro = 1 } if (!(("confirma", g) in LAT)) { printf "ERRO: confirma ausente (config %d)\n", g > "/dev/stderr"; erro = 1 } }
    if (erro) exit 1
    GR[1] = "P1 (03)"; GS[1] = "CRUD + pooler"
    GR[2] = "P2 (04)"; GS[2] = "ES · Wi-Fi"
    GR[3] = "P3 (05)"; GS[3] = "distribuído"
    GR[4] = "R (06)";  GS[4] = "final"
    PCT[1] = "p50"; PCT[2] = "p95"; PCT[3] = "p99"
    grafico_x()
    grafico_lat()
}
' "$CSV" || exit 1

echo "==> gera-graficos.sh: SVGs em $OUT (x-sequencial.svg, latencia-aleatorio.svg)" >&2
