// Contas e avisos: cabeçalhos de segurança, CORS, limite de tentativas de login, troca e redefinição
// de senha (com queda das sessões abertas) e avisos de vencimento por e-mail com 1 mês de antecedência.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias, somarMeses } = require('../src/utils/datas');

let amb;
const tk = {};
const ids = {};
const enviados = [];
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% documento de exemplo\n%%EOF').toString('base64');
let email;
let limite;

before(async () => {
  amb = await iniciarAmbiente();
  email = require('../src/services/email');
  limite = require('../src/services/limiteTentativas');
  email.definirTransporte({ sendMail: async (m) => { enviados.push(m); return { messageId: String(enviados.length) }; } });

  await amb.criarUsuarioNoBanco({ nome: 'Admin Um', email: 'admin1@exemplo.com', senha: 'senha-admin-1', perfil: 'admin' });
  await amb.criarUsuarioNoBanco({ nome: 'Admin Dois', email: 'admin2@exemplo.com', senha: 'senha-admin-2', perfil: 'admin' });
  tk.admin = await amb.login('admin1@exemplo.com', 'senha-admin-1');
  const filial = async (nome, cnpj) => (await api('POST', '/filiais', { token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' } })).body.id;
  ids.A = await filial('Campus Exemplo', '11222333000181');
  ids.B = await filial('Colégio Exemplo', '11444777000161');
  for (const [nome, perfil, filiais] of [['gestorA', 'gestor', [ids.A]], ['tecA', 'tecnico', [ids.A]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome: `Usuário ${nome}`, email: `${nome}@exemplo.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@exemplo.com`, 'senha1234');
  }
});

after(async () => { if (amb) await amb.encerrar(); });

test('cabeçalhos de segurança e CORS fechado para outros sites', async () => {
  const r = await fetch(`${amb.base}/ping`, { headers: { Origin: 'https://site-qualquer.exemplo' } });
  assert.match(r.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline' https:\/\/unpkg\.com/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('access-control-allow-origin'), null, 'outro site não recebe permissão de CORS');
});

test('login: bloqueia depois de 5 erros na mesma conta pelo mesmo IP', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await api('POST', '/auth/login', { body: { email: 'gestora@exemplo.com', senha: 'errada' } })).status, 401);
  }
  const bloqueado = await api('POST', '/auth/login', { body: { email: 'gestorA@exemplo.com', senha: 'senha1234' } });
  assert.equal(bloqueado.status, 429, 'nem a senha certa entra durante o bloqueio');
  assert.ok(Number(bloqueado.headers.get('retry-after')) > 0);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'tecA@exemplo.com', senha: 'senha1234' } })).status, 200, 'outra conta segue entrando');
  limite._registros.clear();
  assert.equal((await api('POST', '/auth/login', { body: { email: 'gestorA@exemplo.com', senha: 'senha1234' } })).status, 200);
});

test('troca de senha pelo próprio usuário derruba as outras sessões', async () => {
  const troca = (body, token = tk.tecA) => api('POST', '/auth/senha', { token, body });
  assert.equal((await troca({ senha_atual: 'errada', nova_senha: 'nova-senha-123' })).status, 400);
  assert.equal((await troca({ senha_atual: 'senha1234', nova_senha: 'curta' })).status, 400);
  assert.equal((await troca({ senha_atual: 'senha1234', nova_senha: 'senha1234' })).status, 400, 'igual à atual');
  assert.equal((await troca({ senha_atual: 'senha1234', nova_senha: 'teca@exemplo.com' })).status, 400, 'o próprio e-mail');
  const outraSessao = await amb.login('tecA@exemplo.com', 'senha1234');
  const ok = await troca({ senha_atual: 'senha1234', nova_senha: 'nova-senha-123' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const velha = await api('GET', '/auth/me', { token: outraSessao });
  assert.equal(velha.status, 401);
  assert.match(velha.body.error, /Sessão encerrada/);
  assert.equal((await api('GET', '/auth/me', { token: ok.body.token })).status, 200, 'esta sessão recebe token novo');
  tk.tecA = await amb.login('tecA@exemplo.com', 'nova-senha-123');
});

test('matriz encerra sessões, redefine senha ou desativa: os tokens abertos caem', async () => {
  const me = (t) => api('GET', '/auth/me', { token: t });
  const gestor = (await api('GET', '/usuarios', { token: tk.admin })).body.find((u) => u.email === 'gestora@exemplo.com');
  assert.equal((await api('POST', `/usuarios/${gestor.id}/encerrar-sessoes`, { token: tk.gestorA })).status, 403);
  assert.equal((await api('POST', `/usuarios/${gestor.id}/encerrar-sessoes`, { token: tk.admin })).status, 204);
  assert.equal((await me(tk.gestorA)).status, 401);
  tk.gestorA = await amb.login('gestorA@exemplo.com', 'senha1234');
  assert.equal((await api('PUT', `/usuarios/${gestor.id}`, { token: tk.admin, body: { senha: 'outra-senha-456' } })).status, 200);
  assert.equal((await me(tk.gestorA)).status, 401);
  tk.gestorA = await amb.login('gestorA@exemplo.com', 'outra-senha-456');
  assert.equal((await me(tk.gestorA)).status, 200);
});

test('esqueci a senha: link por e-mail, vale uma vez, expira e não revela quem tem cadastro', async () => {
  process.env.APP_URL = 'https://sesmt.exemplo';
  enviados.length = 0;
  const pedir = (e) => api('POST', '/auth/esqueci', { body: { email: e } });
  const naoExiste = await pedir('ninguem@exemplo.com');
  assert.equal(naoExiste.status, 202);
  assert.equal(enviados.length, 0);
  const existe = await pedir('TECA@exemplo.com');
  assert.equal(existe.status, 202);
  assert.deepEqual(existe.body, naoExiste.body, 'mesma resposta');
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, 'teca@exemplo.com');
  const link = enviados[0].text.match(/https:\/\/sesmt\.exemplo\/redefinir-senha\.html#token=([\w-]+)/);
  assert.ok(link, enviados[0].text);
  const token = link[1];
  assert.ok(!(await amb.knex('senha_redefinicoes').where({ token_hash: token }).first()), 'o banco guarda só o hash do token');

  const redefinir = (body) => api('POST', '/auth/redefinir', { body });
  assert.equal((await redefinir({ token, nova_senha: 'curta' })).status, 400);
  assert.equal((await redefinir({ token: 'token-inventado', nova_senha: 'senha-redefinida-1' })).status, 400);
  const sessaoAntiga = tk.tecA;
  assert.equal((await redefinir({ token, nova_senha: 'senha-redefinida-1' })).status, 200);
  assert.equal((await redefinir({ token, nova_senha: 'senha-redefinida-2' })).status, 400, 'o link vale uma vez');
  assert.equal((await api('GET', '/auth/me', { token: sessaoAntiga })).status, 401, 'sessões abertas caem');
  tk.tecA = await amb.login('tecA@exemplo.com', 'senha-redefinida-1');

  await pedir('tecA@exemplo.com');
  const token2 = enviados[enviados.length - 1].text.match(/#token=([\w-]+)/)[1];
  await amb.knex('senha_redefinicoes').whereNull('usado_em').update({ expira_em: new Date(Date.now() - 1000) });
  assert.equal((await redefinir({ token: token2, nova_senha: 'senha-redefinida-3' })).status, 400, 'link expirado');

  for (let i = 0; i < 5; i++) await pedir('ninguem@exemplo.com');
  assert.equal((await pedir('ninguem@exemplo.com')).status, 429, 'limite de pedidos por IP');
  limite._registros.clear();
});

test('avisos de vencimento: 1 mês de antecedência, para os admins e os destinatários cadastrados', async () => {
  // Treinamento vencendo em 20 dias (avisa) e outro em 45 (ainda não)
  const setor = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.A, nome: 'Manutenção' } })).body.id;
  const funcao = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Eletricista' } })).body.id;
  const nr35 = (await api('POST', '/treinamentos', { token: tk.admin, body: { nome_treinamento: 'Trabalho em altura', nr_referencia: 'NR-35', carga_horaria: 8, validade_meses: 12 } })).body.id;
  const nr10 = (await api('POST', '/treinamentos', { token: tk.admin, body: { nome_treinamento: 'Segurança em eletricidade', nr_referencia: 'NR-10', carga_horaria: 40, validade_meses: 12 } })).body.id;
  await api('PUT', `/funcoes/${funcao}/treinamentos`, { token: tk.admin, body: { treinamento_ids: [nr35, nr10] } });
  const ana = (await api('POST', '/funcionarios', { token: tk.admin, body: { matricula: '5001', nome: 'Ana <Exemplo>', cpf: '52998224725', data_nascimento: '1990-01-01', data_admissao: '2022-01-10', filial_id: ids.A, setor_id: setor, funcao_id: funcao } })).body.id;
  for (const [t, vence] of [[nr35, 20], [nr10, 45]]) {
    const r = await api('POST', '/certificados', { token: tk.tecA, body: { funcionario_id: ana, treinamento_id: t, data_realizacao: somarMeses(somarDias(HOJE, vence), -12), instituicao: 'Escola Exemplo', arquivo: pdf() } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  // Alvará vencendo em 25 dias e extintor com recarga em 10
  const predio = (await api('POST', '/predios', { token: tk.admin, body: { filial_id: ids.A, nome: 'Prédio 1' } })).body.id;
  assert.equal((await api('POST', '/alvaras', { token: tk.tecA, body: { predio_id: predio, tipo_documento: 'APPCI', numero: '1', data_emissao: somarDias(HOJE, -340), data_validade: somarDias(HOJE, 25), arquivo: pdf() } })).status, 201);
  assert.equal((await api('POST', '/equipamentos-incendio', { token: tk.tecA, body: {
    predio_id: predio, tipo: 'extintor', agente: 'co2', identificacao: 'EXT-01', localizacao: 'Hall',
    manutencoes: [{ tipo: 'recarga', data_servico: somarDias(HOJE, -355), data_proxima: somarDias(HOJE, 10) }, { tipo: 'teste_hidrostatico', data_servico: somarDias(HOJE, -10) }]
  } })).status, 201);

  // Destinatários extras: um para todas as filiais, outro só para o Colégio
  const dest = (body) => api('POST', '/avisos/destinatarios', { token: tk.admin, body });
  assert.equal((await api('POST', '/avisos/destinatarios', { token: tk.gestorA, body: { nome: 'X', email: 'x@exemplo.com' } })).status, 403);
  assert.equal((await dest({ nome: 'Sem e-mail', email: 'nao-e-email' })).status, 400);
  assert.equal((await dest({ nome: 'Filial errada', email: 'f@exemplo.com', filial_ids: [99999] })).status, 400);
  assert.equal((await dest({ nome: 'Técnica de segurança', email: 'Tecnica@Exemplo.com' })).status, 201);
  assert.equal((await dest({ nome: 'Repetida', email: 'tecnica@exemplo.com' })).status, 409);
  const colegio = await dest({ nome: 'Coordenação do Colégio', email: 'colegio@exemplo.com', filial_ids: [ids.B] });
  assert.equal(colegio.status, 201);

  const previa = await api('GET', '/avisos/previa', { token: tk.admin });
  assert.equal(previa.status, 200, JSON.stringify(previa.body));
  assert.equal(previa.body.limite, somarMeses(HOJE, 1));
  const desc = previa.body.itens.map((i) => `${i.modulo}: ${i.descricao}`);
  assert.ok(desc.some((d) => d.includes('NR-35')), 'vence em 20 dias');
  assert.ok(!desc.some((d) => d.includes('NR-10')), 'vence em 45 dias: fora do aviso de 1 mês');
  assert.ok(desc.some((d) => d.startsWith('Alvará')));
  assert.ok(desc.some((d) => d.includes('EXT-01') && d.includes('Recarga')));
  assert.deepEqual(previa.body.destinatarios.map((d) => d.email).sort(),
    ['admin1@exemplo.com', 'admin2@exemplo.com', 'colegio@exemplo.com', 'tecnica@exemplo.com']);

  enviados.length = 0;
  const envio = await api('POST', '/avisos/enviar', { token: tk.admin });
  assert.equal(envio.status, 201, JSON.stringify(envio.body));
  assert.deepEqual(enviados.map((m) => m.to).sort(), ['admin1@exemplo.com', 'admin2@exemplo.com', 'tecnica@exemplo.com'], 'o Colégio não tem nada vencendo');
  assert.equal(envio.body.resultado.find((r) => r.email === 'colegio@exemplo.com').motivo, 'nada_a_vencer');
  const msg = enviados[0];
  assert.match(msg.subject, new RegExp(`a vencer até ${somarMeses(HOJE, 1).split('-').reverse().join('/')}`));
  assert.match(msg.text, /Campus Exemplo/);
  assert.ok(msg.html.includes('Ana &lt;Exemplo&gt;'), 'o HTML escapa o que vem do cadastro');

  // Parou de receber
  assert.equal((await api('PUT', `/avisos/destinatarios/${colegio.body.id}`, { token: tk.admin, body: { ativo: false } })).status, 200);
  assert.equal((await api('GET', '/avisos/previa', { token: tk.admin })).body.destinatarios.length, 3);

  // A mesma semana não sai duas vezes; sem SMTP, o envio manual avisa
  const { enviarAvisos, semanaIso } = require('../src/services/avisos');
  assert.equal(semanaIso('2026-11-24'), '2026-W48');
  assert.equal((await enviarAvisos(amb.knex, { referencia: 'semana-teste' })).enviado, true);
  assert.equal((await enviarAvisos(amb.knex, { referencia: 'semana-teste' })).motivo, 'ja_enviado');
  assert.equal((await api('GET', '/avisos/envios', { token: tk.admin })).body.length, 2);
  email.definirTransporte(null);
  assert.equal((await api('POST', '/avisos/enviar', { token: tk.admin })).status, 503);
});
