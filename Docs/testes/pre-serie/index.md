# Referência pré-série: monólito sem pooler (Fase 2)

**Configuração:** Monólito CRUD, Postgres direto (sem pooler), read model com lag sintético.

Rodadas 1a/1b (matriz CAS × ingênuo) e escada do limiar X da Fase 2, antes do Supabase. Não entram na série de 3 pontos: a #22 refez o protocolo pelo pooler. Ficam como referência do custo do pooler.

## Páginas

- [Etapa 01: monólito sem pool de conexões](/testes/pre-serie/sem-pool)
- [Etapa 02: monólito + HikariCP, Postgres direto](/testes/pre-serie/hikari)
- [Análise dos resultados de carga (2026-10-04)](/testes/pre-serie/analise)
- [Resultados dos testes de carga (2026-10-04)](/testes/pre-serie/resultados-de-carga)
- [Escada de degraus: resultados de 2026-10-16](/testes/pre-serie/resultados-escada-2026-10-16)
- [Matriz CAS × ingênuo: resultados de 2026-10-16](/testes/pre-serie/resultados-matriz-2026-10-16)
