#!/bin/bash

# =============================================================================
#  gera-graficos-fase2.sh · figuras da Fase 2 no artigo (issue #15)
# =============================================================================
#
#  Gera, dos CSVs versionados em Projeto/carga/results, os SVGs do pré-pooler e do ponto 1
#  (pós-pooler) citados em "Resultados" de docs/artigo/experimento-monolito.md:
#
#    matriz-prepooler.svg          overselling × lag, matriz pré-pooler (02-hikari/matriz-prepooler-20261016.csv)
#    matriz-pooler.svg             overselling × lag, ponto 1 (03-supabase-pooler/matriz.csv)
#    escada-prepooler-958305.svg   escada fina 95k a 100k (passo 1k): o X pré-pooler, 97k
#    escada-prepooler-956799.svg   escada larga 60k a 130k: a tabela de degraus do artigo, X = 100k
#    escada-pooler-33459.svg       escada fina 70k a 80k pelo pooler (o X adotado pelo artigo, 78k, sai dos degraus
#                                  dela; o traço automático do report marca 70k, o degrau de aquecimento)
#
#  Não reescreve nenhum gráfico: roda o report-matriz.sh / report-degraus.sh (docs/carga/harness) sobre o CSV,
#  para um HTML temporário (nunca fica em graficos/), recorta os <svg> dos painéis que o aceite pede e os monta
#  num SVG autocontido, com o próprio <style> e o tema claro/escuro por @media (prefers-color-scheme: dark),
#  como o x-sequencial.svg. O HTML sozinho não serve de SVG solto: os painéis dependem do <style> e das
#  variáveis de cor da página. Os números plotados são os do report; o único texto calculado aqui é o
#  <desc>/aria-label, lido da tabela do próprio HTML.
#
#  Matriz: só os painéis de overselling (o p95 fica nas tabelas do artigo). Escada: os 3 painéis do report
#  (latência, throughput, 5xx das reservas) e o veredito do report.
#
#  Uso:  gera-graficos-fase2.sh [pasta-de-saida [figura]]   (sem argumento: a pasta do script, as cinco figuras)
#  Um comando por figura (de docs/artigo/graficos; a saída é determinística):
#    bash gera-graficos-fase2.sh . matriz-prepooler
#    bash gera-graficos-fase2.sh . matriz-pooler
#    bash gera-graficos-fase2.sh . escada-prepooler-958305
#    bash gera-graficos-fase2.sh . escada-prepooler-956799
#    bash gera-graficos-fase2.sh . escada-pooler-33459
#  Roda em qualquer bash com awk e sed (o Git Bash serve). Sem lib externa.
# =============================================================================

set -uo pipefail
export LC_ALL=C   # ponto decimal no printf do awk, independente do locale

AQUI="$(cd "$(dirname "$0")" && pwd)"
HARNESS="$AQUI/../../carga/harness"
RES="$AQUI/../../../Projeto/carga/results"
OUT="${1:-$AQUI}"
FIG="${2:-}"   # nome de uma figura (sem .svg); vazio = todas
mkdir -p "$OUT"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

quer() { [ -z "$FIG" ] || [ "$FIG" = "$1" ]; }
esc() { sed 's/&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g;s/"/\&quot;/g' <<<"$1"; }
vir() { sed 's/\([0-9]\)\.\([0-9]\)/\1,\2/g' <<<"$1"; }   # 3.9 -> 3,9 (como o artigo)

# tokens iguais aos do report-*.sh (paleta validada com a skill dataviz)
estilo() {
    cat <<'CSS'
<style>
  :root { --surface-1:#fcfcfb; --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#898781; --grid:#e1e0d9; --baseline:#c3c2b7; --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a; --series-4:#eda100; }
  @media (prefers-color-scheme: dark) {
    :root { --surface-1:#1a1a19; --text-primary:#ffffff; --text-secondary:#c3c2b7; --grid:#2c2c2a; --baseline:#383835; --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500; }
  }
  text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; }
  svg { overflow: visible; }
  .bg { fill: var(--surface-1); }
  .titulo { fill: var(--text-primary); font-size: 16px; font-weight: 600; }
  .sub { fill: var(--text-secondary); font-size: 12px; }
  .tp { fill: var(--text-primary); font-size: 13px; font-weight: 600; }
  .ts { fill: var(--text-secondary); font-size: 12px; }
  .tm { fill: var(--text-muted); font-size: 11px; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .baseline { stroke: var(--baseline); stroke-width: 1; }
  .eixo { fill: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .rotulo-serie { fill: var(--text-secondary); font-size: 11px; }
  .rotulo-x { fill: var(--text-primary); font-size: 11px; font-weight: 600; }
  .marca-x { stroke: var(--text-secondary); stroke-width: 1.5; }
</style>
CSS
}

# extrai <html> <dir>: grava cada <svg>...</svg> do HTML do report em <dir>/p1.svg, p2.svg... (na ordem)
extrai() {
    rm -rf "$2"; mkdir -p "$2"
    awk -v dir="$2" '
        /^<svg / { dentro = 1; buf = "" }
        dentro { buf = buf $0 "\n" }
        /^<\/svg>/ { if (dentro) { n++; f = dir "/p" n ".svg"; printf "%s", buf > f; close(f) } dentro = 0 }
    ' "$1"
}

# painel <arquivo> <x> <y>: o <svg> do painel (420x250) aninhado na posição x,y
painel() { sed "1s|width=\"100%\"|x=\"$2\" y=\"$3\" width=\"420\" height=\"250\"|" "$1"; }

# legenda <x> <y> <largura> item...   item = "cor|t ou -|texto" (t = tracejado); quebra a linha na largura
legenda() {
    local x="$1" y="$2" lmax="$3"; shift 3
    printf '%s\n' "$@" | awk -F'|' -v x0="$x" -v y0="$y" -v lmax="$lmax" '
        BEGIN { cx = x0; cy = y0 }
        { w = 22 + length($3) * 5.9 + 14
          if (cx > x0 && cx + w - 14 > x0 + lmax) { cx = x0; cy += 16 }
          printf "<line x1=\"%.1f\" y1=\"%.1f\" x2=\"%.1f\" y2=\"%.1f\" stroke=\"%s\" stroke-width=\"2.5\" stroke-linecap=\"round\"%s/><text class=\"ts\" x=\"%.1f\" y=\"%.1f\">%s</text>\n", cx, cy - 4, cx + 16, cy - 4, $1, ($2 == "t" ? " stroke-dasharray=\"5 3\"" : ""), cx + 22, cy, $3
          cx += w }'
}

# ------------------------------------------------------------------ matriz: overselling × lag
# fig_matriz <csv> <saida.svg> <titulo> <subtitulo>
fig_matriz() {
    local csv="$1" out="$2" tit="$3" sub="$4" html="$T/m.html" d="$T/m" n i x y col row h desc head
    bash "$HARNESS/report-matriz.sh" "$csv" "$html" 2>/dev/null || { echo "ERRO: report-matriz.sh falhou em $csv" >&2; return 1; }
    extrai "$html" "$d"
    # painéis na ordem do report: por grupo (N, capacity), overselling e depois p95; só o de overselling
    : > "$T/lista"
    for f in "$d"/p*.svg; do
        grep -q '^<svg .*aria-label="Overselling por lag' "$f" && echo "$f" >> "$T/lista"
    done
    n=$(wc -l < "$T/lista")
    [ "$n" -ge 1 ] || { echo "ERRO: nenhum painel de overselling em $csv" >&2; return 1; }

    # <desc>: média do overselling por (N, lag) lida da tabela do HTML (braço, lag, N, capacity, rep, média, ...)
    desc=$(sed -n '/<tbody>/,/<\/tbody>/p' "$html" | sed 's/<\/td><td>/|/g;s/<[^>]*>//g' | awk -F'|' '
        NF >= 9 { k = "N = " $3 " (capacity " $4 ")"; if (!(k in T)) { ord[++g] = k }
                  m = $6 + 0; T[k] = T[k] (T[k] == "" ? "" : "; ") $1 " no lag " $2 " ms: " m }
        END { for (i = 1; i <= g; i++) printf "%s%s: %s", (i > 1 ? ". " : ""), ord[i], T[ord[i]] }')
    desc="Overselling médio por lag e braço. $(vir "$desc")"

    h=$(( 112 + ((n + 1) / 2) * 290 + 40 ))
    {
        printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 %d" width="100%%" role="img" aria-label="%s: %s">\n' "$h" "$(esc "$tit")" "$(esc "$desc")"
        printf '<title>%s</title>\n<desc>%s</desc>\n' "$(esc "$tit")" "$(esc "$desc")"
        estilo
        printf '<rect class="bg" width="880" height="%d"/>\n' "$h"
        printf '<text class="titulo" x="16" y="26">%s</text>\n' "$(esc "$tit")"
        printf '<text class="sub" x="16" y="45">%s</text>\n' "$(esc "$sub")"
        legenda 16 68 850 'var(--series-1)|t|cas · independe do lag (linha de referência)' 'var(--series-2)|-|naive (curva)'
        i=0
        while read -r f; do
            col=$(( i % 2 )); row=$(( i / 2 )); i=$(( i + 1 ))
            x=$(( 10 + col * 440 )); y=$(( 112 + row * 290 ))
            head=$(sed -n '1s/.*aria-label="Overselling por lag, \([^"]*\)".*/\1/p' "$f" | sed 's/N=/N = /;s/, capacity/ · capacity/')
            printf '<text class="tp" x="%d" y="%d">Overselling · %s</text>\n' $(( x + 42 )) $(( y - 6 )) "$(esc "$head")"
            painel "$f" "$x" "$y"
        done < "$T/lista"
        printf '<text class="tm" x="16" y="%d">Marcador = média das repetições · barra grossa = ±1 desvio amostral · linha fina = mín–máx · eixo x linear em ms.</text>\n' $(( h - 24 ))
        printf '<text class="tm" x="16" y="%d">Overselling = max(0, confirmed − capacity). Valores exatos nas tabelas do artigo e no tooltip de cada marcador.</text>\n' $(( h - 10 ))
        printf '</svg>\n'
    } > "$out"
    echo "    $out" >&2
}

# ------------------------------------------------------------------ escada: latência, throughput e 5xx × RPM alvo
# fig_escada <csv> <saida.svg> <titulo> <subtitulo> [nota...]
# Variáveis opcionais, só a figura do pooler as usa: ADOTADO (RPM do X que o artigo adota quando o veredito do report
# não vale), ADOTADO_MOTIVO e ADOTADO_RESSALVA (por que o traço do report não vale). Com elas, o traço do report fica
# esmaecido e rotulado "report (não usado)" e o X adotado ganha traço sólido nos 3 painéis. Sem elas, nada muda.
fig_escada() {
    local csv="$1" out="$2" tit="$3" sub="$4" html="$T/e.html" d="$T/e" ver desc y nota notas n2 verx rmin rmax xa f; shift 4
    bash "$HARNESS/report-degraus.sh" "$csv" "$html" 2>/dev/null || { echo "ERRO: report-degraus.sh falhou em $csv" >&2; return 1; }
    extrai "$html" "$d"
    [ -f "$d/p3.svg" ] || { echo "ERRO: esperava 3 painéis em $csv" >&2; return 1; }

    # veredito do próprio report (texto até o "Atenção"), com vírgula decimal; o texto já vem com entidades XML
    ver=$(grep -o '<p class="veredito"[^>]*>[^<]*' "$html" | sed 's/^<p class="veredito"[^>]*>//;s/ Atenção.*//')
    ver="$(vir "$ver")"
    # <desc>: p95 de janela e throughput por degrau, da tabela do HTML (alvo, efetivo, 5xx%, p50, p95, p99, janela, thr, descartes, outros, situação)
    desc=$(sed -n '/<tbody>/,/<\/tbody>/p' "$html" | sed 's/<\/td><td>/|/g;s/<[^>]*>//g' | awk -F'|' '
        NF >= 10 { a = $1; j = ($7 == "n/d" ? "n/d" : $7); s = s (s == "" ? "" : "; ") a ": p95 de janela " j " ms, 5xx " $3 "%, descartes " $9 }
        END { printf "%s", s }')
    if [ -n "${ADOTADO:-}" ]; then
        verx="${ver%%:*}"   # "X = 70000 RPM"
        # posição do X adotado no painel: a conta do xpos() do report-degraus.sh (xl = 66, xr - xl = 270, eixo linear do 1º ao último degrau)
        read -r rmin rmax < <(sed -n '/<tbody>/,/<\/tbody>/p' "$html" | sed 's/<\/td><td>/|/g;s/<[^>]*>//g' | awk -F'|' 'NF >= 10 { if (!n++) a = $1; b = $1 } END { print a, b }')
        xa=$(awk -v r="$ADOTADO" -v a="$rmin" -v b="$rmax" 'BEGIN { printf "%.1f", 66 + (r - a) / (b - a) * 270 }')
        for f in "$d/p1.svg" "$d/p2.svg" "$d/p3.svg"; do
            sed -i 's|class="marca-x"|class="marca-x marca-desc"|; s|\(class="rotulo-x\)\("[^>]*\)>X</text>|\1 rotulo-desc\2>report (não usado)</text>|' "$f"
            awk -v xa="$xa" -v rot="X adotado ≈ $(( ADOTADO / 1000 ))k" '$0 == "</svg>" { printf "<line class=\"marca-adot\" x1=\"%s\" y1=\"14\" x2=\"%s\" y2=\"214\"/>\n<text class=\"rotulo-x\" x=\"%.1f\" y=\"24\" text-anchor=\"end\">%s</text>\n", xa, xa, xa - 5, rot } { print }' "$f" > "$f.n" && mv "$f.n" "$f"
        done
        desc="X adotado ≈ $(( ADOTADO / 1000 )).000 RPM ($ADOTADO_MOTIVO). Veredito automático do report: $verx, não usado ($ADOTADO_RESSALVA). Por degrau (RPM alvo): $(vir "$desc")."
    else
        desc="Veredito do report: $(sed 's/&gt;/>/g' <<<"$ver") Por degrau (RPM alvo): $(vir "$desc")."
    fi

    {
        printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 750" width="100%%" role="img" aria-label="%s: %s">\n' "$(esc "$tit")" "$(esc "$desc")"
        printf '<title>%s</title>\n<desc>%s</desc>\n' "$(esc "$tit")" "$(esc "$desc")"
        estilo
        [ -z "${ADOTADO:-}" ] || printf '<style>\n  .marca-adot { stroke: var(--text-primary); stroke-width: 2; }\n  .marca-desc { stroke-opacity: .35; stroke-dasharray: 3 3; }\n  .rotulo-desc { fill: var(--text-muted); font-weight: 400; }\n</style>\n'
        printf '<rect class="bg" width="880" height="750"/>\n'
        printf '<text class="titulo" x="16" y="26">%s</text>\n' "$(esc "$tit")"
        printf '<text class="sub" x="16" y="45">%s</text>\n' "$(esc "$sub")"
        if [ -n "${ADOTADO:-}" ]; then
            printf '<text class="tp" x="16" y="68">X adotado ≈ %d.000 RPM: %s.</text>\n' $(( ADOTADO / 1000 )) "$ADOTADO_MOTIVO"
            printf '<text class="ts" x="16" y="86">Veredito automático do report: %s (não usado: %s).</text>\n' "$verx" "$ADOTADO_RESSALVA"
        else
            printf '<text class="tp" x="16" y="68">Veredito do report: %s</text>\n' "$ver"
        fi

        printf '<text class="tp" x="52" y="104">Latência da reserva (ms)</text>\n'
        legenda 52 122 400 'var(--series-1)|-|p50' 'var(--series-2)|-|p95 do degrau' 'var(--series-3)|-|p99' 'var(--series-4)|-|p95 da pior janela de 30 s' 'var(--text-muted)|t|limiar: p95 = 1 s'
        painel "$d/p1.svg" 10 150
        printf '<text class="tp" x="492" y="104">Throughput (reservas/s)</text>\n'
        legenda 492 122 400 'var(--series-1)|-|throughput (reservas/s sem 5xx)' 'var(--series-2)|-|enviadas (RPM efetivo / 60)' 'var(--text-muted)|t|carga oferecida (alvo)'
        painel "$d/p2.svg" 450 150

        printf '<text class="tp" x="52" y="432">Taxa de 5xx das reservas (%%)</text>\n'
        legenda 52 450 400 'var(--series-1)|-|taxa de 5xx das reservas (%)' 'var(--text-muted)|t|limiar: 5xx das reservas = 1%'
        painel "$d/p3.svg" 10 470

        y=492
        n2="Traço vertical rotulado X = degrau X do report."
        [ -z "${ADOTADO:-}" ] || n2="Sólido = X adotado; esmaecido = X do report (não usado)."
        notas=("Eixo x linear em RPM alvo; um marcador por degrau." "$n2"
               "X = 1º degrau com 5xx das reservas > 1%" "ou p95 > 1 s numa janela de 30 s."
               "Gerador saturado = descartes > 0 ou" "RPM efetivo < 95% do alvo.")
        for nota in "${notas[@]}" "$@"; do
            printf '<text class="ts" x="492" y="%d">%s</text>\n' "$y" "$(esc "$nota")"
            y=$(( y + 18 ))
        done
        printf '</svg>\n'
    } > "$out"
    echo "    $out" >&2
}

case "$FIG" in ""|matriz-prepooler|matriz-pooler|escada-prepooler-958305|escada-prepooler-956799|escada-pooler-33459) ;;
    *) echo "ERRO: figura desconhecida: $FIG" >&2; exit 1 ;; esac
echo "==> gera-graficos-fase2.sh: SVGs em $OUT" >&2
quer matriz-prepooler && { fig_matriz "$RES/02-hikari/matriz-prepooler-20261016.csv" "$OUT/matriz-prepooler.svg" \
    "Overselling × lag, pré-pooler (monólito + HikariCP)" \
    "Matriz de 2026-10-16, capacity 20, 100% de confirmação. Fonte: 02-hikari/matriz-prepooler-20261016.csv" || exit 1; }
quer matriz-pooler && { fig_matriz "$RES/03-supabase-pooler/matriz.csv" "$OUT/matriz-pooler.svg" \
    "Overselling × lag, ponto 1 (pós-pooler)" \
    "Matriz de 2026-10-16, capacity 20, 100% de confirmação, Supabase + Supavisor. Fonte: 03-supabase-pooler/matriz.csv" || exit 1; }
quer escada-prepooler-958305 && { fig_escada "$RES/02-hikari/degraus-958305.csv" "$OUT/escada-prepooler-958305.svg" \
    "Limiar X pré-pooler: escada fina de 95k a 100k" \
    "Braço CAS, 200 usuários, passo de 1k RPM, mapeamento sequencial. Fonte: 02-hikari/degraus-958305.csv" || exit 1; }
quer escada-prepooler-956799 && { fig_escada "$RES/02-hikari/degraus-956799.csv" "$OUT/escada-prepooler-956799.svg" \
    "Limiar X pré-pooler: escada de 60k a 130k" \
    "Braço CAS, 200 usuários, passo de 10k RPM, mapeamento sequencial. Fonte: 02-hikari/degraus-956799.csv" || exit 1; }
quer escada-pooler-33459 && { ADOTADO=78000 ADOTADO_MOTIVO="1º degrau de saturação sustentada" ADOTADO_RESSALVA="o 70k é aquecimento"     fig_escada "$RES/03-supabase-pooler/degraus-33459.csv" "$OUT/escada-pooler-33459.svg"     "Limiar X pelo pooler: escada fina de 70k a 80k"     "Braço CAS, 200 usuários, passo de 1k RPM, pool 245. Fonte: 03-supabase-pooler/degraus-33459.csv" || exit 1; }
echo "==> gera-graficos-fase2.sh: pronto" >&2
