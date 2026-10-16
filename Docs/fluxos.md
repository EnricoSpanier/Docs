---
title: Fluxo de Dados
sidebar_label: Fluxo de Dados
---

# Fluxo de dados — hoje e no fim do projeto

Diagrama animado do caminho de uma requisição em três visões: o monólito atual (branch
`Fase_2`), a arquitetura final em microsserviços com CQRS + Event Sourcing, e uma simulação de
pico num único evento. Na simulação, o uso do `reservation` é RPM ÷ (X × réplicas), com X o
limiar medido no experimento. Acima de 50% sobe uma réplica em stand-by; acima de 80% o
`admission` manda as reservas para a fila, que entrega ao serviço já com a réplica nova. Planejado,
não implementado: issues #111 (`gateway` e `reservation`) e #112 (demais serviços).
O interruptor "Gargalo na linha do `eventcap`" mostra o outro cenário possível: como toda reserva
do evento atualiza a mesma linha, a vazão fica em X por mais réplicas que subam. Qual dos dois
vale é hipótese a medir na #111.

[Abrir em tela cheia](pathname:///embed/fluxos.html)

<iframe src="/embed/fluxos.html" title="Fluxo de dados" loading="lazy" style={{width: "100%", height: "85vh", border: 0, borderRadius: 8}}></iframe>
