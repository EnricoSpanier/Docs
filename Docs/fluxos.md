---
title: Fluxo de Dados
sidebar_label: Fluxo de Dados
---

# Fluxo de dados — o sistema no estado final

Diagrama animado do caminho de uma requisição em duas visões. A primeira mostra a arquitetura
implementada: o `gateway` (o único conteúdo do monólito), os serviços `identity`, `catalog`,
`reservation`, `stock`, `admission` e `notification`, e a infraestrutura (Supavisor, Postgres,
Redpanda, Redis e RabbitMQ). A tabela no fim compara o plano inicial com o que foi implementado.

A segunda visão simula um pico de reservas num único evento. O `admission` calcula o uso de cada
evento como RPM ÷ (X × réplicas), com X = 56k RPM por evento (etapa 06). Com uso a partir de 80%
as reservas vão para a fila e recebem 202; abaixo de 70%, com a fila vazia, voltam ao caminho
síncrono. A autoescala foi implementada de dois jeitos: no compose, com HAProxy e um scaler no
host (#111/#112, medida nas etapas 07 e 08), e no Kubernetes (kind), com KEDA e HPA (#197, etapa 10).

O interruptor "Gargalo na linha do `eventcap`" vem ligado, porque é o que as medições indicam como
provável: subir réplicas não aumenta a vazão de um único evento quente. Com a carga concentrada
num evento, X ficou em ≈ 56k RPM, contra ≈ 86k com a carga espalhada (etapa 06). Os braços com
autoescala pararam antes de X: entre 32k e 44k no compose (etapas 07 e 08) e entre 20k e 32k no
Kubernetes (etapa 10). Na última rodada no Kubernetes, o limite provável, ainda não isolado, é o
lock da linha quente do `eventcap`.

[Abrir em tela cheia](pathname:///embed/fluxos.html)

<iframe src="/embed/fluxos.html" title="Fluxo de dados" loading="lazy" style={{width: "100%", height: "85vh", border: 0, borderRadius: 8}}></iframe>
