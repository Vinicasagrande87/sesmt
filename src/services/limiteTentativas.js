// Limite de tentativas (login, "esqueci a senha"), em memória.
// Janela deslizante: passou do limite dentro da janela, a chave fica bloqueada até a janela esvaziar.
// Em memória vale para um servidor só; com vários, o limite passa a ser por servidor (ainda protege).
const registros = new Map(); // chave -> [instantes das falhas]

const REGRAS = {
  login_conta: { max: 5, janelaMs: 15 * 60 * 1000 },      // mesma conta + mesmo IP
  login_ip: { max: 30, janelaMs: 15 * 60 * 1000 },        // mesmo IP, qualquer conta
  redefinicao_ip: { max: 5, janelaMs: 60 * 60 * 1000 }    // pedidos de redefinição de senha por IP
};

function recentes(chave, janelaMs, agora) {
  const lista = (registros.get(chave) || []).filter((t) => agora - t < janelaMs);
  if (lista.length) registros.set(chave, lista); else registros.delete(chave);
  return lista;
}

// Segundos até liberar, ou 0 se pode tentar
function bloqueadoPor(regra, chave, agora = Date.now()) {
  const { max, janelaMs } = REGRAS[regra];
  const lista = recentes(`${regra}:${chave}`, janelaMs, agora);
  if (lista.length < max) return 0;
  return Math.ceil((lista[lista.length - max] + janelaMs - agora) / 1000);
}

function registrar(regra, chave, agora = Date.now()) {
  const k = `${regra}:${chave}`;
  const lista = recentes(k, REGRAS[regra].janelaMs, agora);
  lista.push(agora);
  registros.set(k, lista);
}

function limpar(regra, chave) {
  registros.delete(`${regra}:${chave}`);
}

// Faxina periódica das chaves antigas (não segura o processo aberto)
setInterval(() => {
  const agora = Date.now();
  const maior = Math.max(...Object.values(REGRAS).map((r) => r.janelaMs));
  for (const [k, lista] of registros) if (!lista.some((t) => agora - t < maior)) registros.delete(k);
}, 10 * 60 * 1000).unref();

module.exports = { REGRAS, bloqueadoPor, registrar, limpar, _registros: registros };
