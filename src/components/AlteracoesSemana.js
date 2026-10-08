import React, { useEffect, useState } from "react";
import Link from "@docusaurus/Link";
import alteracoes from "@site/static/alteracoes.json";

const SEMANA_MS = 7 * 24 * 60 * 60 * 1000;
const dataBr = (iso) => new Date(iso).toLocaleDateString("pt-BR");

// O "agora" só existe no cliente: o site pode ficar dias sem rebuild, então o filtro de 7 dias
// não pode ser calculado no build.
export default function AlteracoesSemana() {
  const [agora, setAgora] = useState(null);
  useEffect(() => setAgora(Date.now()), []);
  if (agora === null || alteracoes.length === 0) return null;

  const semana = alteracoes.filter((a) => agora - new Date(a.data) <= SEMANA_MS);
  const itens = semana.length ? semana : alteracoes.slice(0, 1);

  return (
    <section>
      <h2>Alterações da semana</h2>
      {!semana.length && <p>Sem alterações nos últimos 7 dias. Última alteração:</p>}
      <ul>
        {itens.map((a) => (
          <li key={a.link}>
            <Link to={a.link}>{a.titulo}</Link> — {dataBr(a.data)} (
            {agora - new Date(a.criado) <= SEMANA_MS ? "novo" : "atualizado"})
          </li>
        ))}
      </ul>
    </section>
  );
}
