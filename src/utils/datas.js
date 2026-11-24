// Funções de data. Trabalhamos sempre com strings 'YYYY-MM-DD' para evitar problemas de fuso
// (o db.js configura o Postgres para devolver colunas DATE nesse formato).

const FUSO = 'America/Sao_Paulo';

// Data de hoje no fuso de Brasília, no formato 'YYYY-MM-DD'
function hoje() {
  return new Date().toLocaleDateString('en-CA', { timeZone: FUSO });
}

// Converte o que vier do banco (Date ou string) para 'YYYY-MM-DD'
function paraISO(valor) {
  if (!valor) return null;
  if (typeof valor === 'string') return valor.slice(0, 10);
  // mysql2 e pg devolvem colunas DATE como Date à meia-noite local
  const a = valor.getFullYear();
  const m = String(valor.getMonth() + 1).padStart(2, '0');
  const d = String(valor.getDate()).padStart(2, '0');
  return `${a}-${m}-${d}`;
}

// Soma dias a uma data 'YYYY-MM-DD' e devolve 'YYYY-MM-DD'
function somarDias(dataISO, dias) {
  const [a, m, d] = paraISO(dataISO).split('-').map(Number);
  const data = new Date(Date.UTC(a, m - 1, d));
  data.setUTCDate(data.getUTCDate() + Number(dias));
  return data.toISOString().slice(0, 10);
}

// Soma meses mantendo o dia; se o mês não tem esse dia, usa o último (31/01 + 1 mês = 28/02)
function somarMeses(dataISO, meses) {
  const [a, m, d] = paraISO(dataISO).split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + Number(meses), 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

// Dias entre duas datas 'YYYY-MM-DD' (inclusive nas duas pontas)
function diasEntre(inicioISO, fimISO) {
  const ms = Date.parse(`${fimISO}T00:00:00Z`) - Date.parse(`${inicioISO}T00:00:00Z`);
  return Math.round(ms / 86400000) + 1;
}

// Data (fuso de Brasília) de um instante vindo do banco (timestamp): 'YYYY-MM-DD'
function dataLocal(instante) {
  if (!instante) return null;
  return new Date(instante).toLocaleDateString('en-CA', { timeZone: FUSO });
}

function dataValida(texto) {
  if (typeof texto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  return somarDias(texto, 0) === texto; // rejeita 2026-02-31, por exemplo
}

module.exports = { hoje, paraISO, somarDias, somarMeses, diasEntre, dataValida, dataLocal };
