# Ponto 1: monólito CRUD pelo pooler (#22)

**Configuração:** Monólito CRUD, Supabase Postgres + Supavisor (Fase 4), read model com lag sintético.

Baseline oficial da série. Matriz CAS × ingênuo pelo pooler, isolamento do custo do Supavisor e escada do limiar X pelo pooler.

Seção no artigo: [Ponto 1: monólito CRUD](/testes/artigo/experimento-monolito#ponto-1-pós-pooler-overselling--lag-e-latência).

## Páginas

- [Etapa 03: Supabase Postgres + Supavisor](/testes/ponto-1/supabase-pooler)
- [Isolamento do pooler e escada X pelo pooler: resultados de 2026-10-17](/testes/ponto-1/resultados-isolamento-escada-pospooler-2026-10-17)
- [Matriz CAS × ingênuo depois do pooler: resultados de 2026-10-16](/testes/ponto-1/resultados-matriz-pospooler-2026-10-16)
