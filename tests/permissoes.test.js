// Permissão de trabalho: conferência de treinamento e ASO (recusa quem não pode), papéis e checklist por tipo,
// medição de atmosfera no espaço confinado (fora do limite suspende), assinatura por crachá + PIN, encerramento,
// verificação pública, exigências definidas pela matriz, pendências e integrações.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias, somarMeses } = require('../src/utils/datas');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% documento de exemplo\n%%EOF').toString('base64');
const instante = (horas) => new Date(Date.now() + horas * 3600 * 1000).toISOString();
const qr = async (id) => (await amb.knex('funcionarios').where({ id }).first('qr_token')).qr_token;

const CHECK_ALTURA = { analise_risco: true, ancoragem: true, equipamentos: true, isolamento: true, clima: true, resgate: true, queda_objetos: true };
const CHECK_CONFINADO = { identificacao: true, bloqueio_energias: true, ventilacao: true, monitoramento_continuo: true, comunicacao: true, resgate: true, equipamentos_atmosfera: true };
const altura = (participantes, extra = {}) => ({
  filial_id: ids.A, tipo: 'altura', local_descricao: 'Telhado do prédio 1', servico: 'Troca de telhas quebradas', inicio: instante(0), fim: instante(8),
  checklist: CHECK_ALTURA, epis: 'Cinto paraquedista, talabarte duplo, capacete com jugular', participantes, ...extra
});

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@exemplo.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@exemplo.com', 'senha-admin');
  ids.A = (await api('POST', '/filiais', { token: tk.admin, body: { nome: 'Campus Exemplo', cnpj: '11222333000181', uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' } })).body.id;
  ids.setor = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.A, nome: 'Manutenção' } })).body.id;
  ids.funcao = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Oficial de manutenção' } })).body.id;
  const trein = async (nome, nr, validade) => (await api('POST', '/treinamentos', { token: tk.admin, body: { nome_treinamento: nome, nr_referencia: nr, carga_horaria: 8, validade_meses: validade } })).body.id;
  ids.nr35 = await trein('Trabalho em altura', 'NR-35', 24);
  ids.nr33 = await trein('Espaço confinado — trabalhador e vigia', 'NR 33', 12);
  ids.resgate = await trein('Resgate em altura', null, 12);
  for (const [nome, perfil] of [['gestorA', 'gestor'], ['tecA', 'tecnico'], ['saudeA', 'saude'], ['consultaA', 'consulta']]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome: `Usuário ${nome}`, email: `${nome}@exemplo.com`, senha: 'senha1234', perfil, filiais: [ids.A] } });
    tk[nome] = await amb.login(`${nome}@exemplo.com`, 'senha1234');
  }
  const cpfs = { ana: '52998224725', bruno: '12345678909', carla: '11144477735', diego: '39053344705', elisa: '15350946056', fabio: '86288366757', gil: '71428793860' };
  const pinHash = await bcrypt.hash('7395', 4);
  for (const [i, [nome, cpf]] of Object.entries(cpfs).entries()) {
    const r = await api('POST', '/funcionarios', { token: tk.admin, body: { matricula: String(7001 + i), nome: nome[0].toUpperCase() + nome.slice(1), cpf,
      data_nascimento: '1990-01-01', data_admissao: '2022-01-10', filial_id: ids.A, setor_id: ids.setor, funcao_id: ids.funcao } });
    ids[nome] = r.body.id;
    await amb.knex('funcionarios').where({ id: r.body.id }).update({ pin_hash: pinHash });
  }
  const cert = (funcionario, treinamento, data) => api('POST', '/certificados', { token: tk.tecA, body: { funcionario_id: funcionario, treinamento_id: treinamento, data_realizacao: data, instituicao: 'Escola Exemplo', arquivo: pdf() } });
  const aso = (funcionario, resultado = 'apto', extra = {}) => api('POST', '/asos', { token: tk.saudeA, body: { funcionario_id: funcionario, tipo: 'periodico', data_exame: somarDias(HOJE, -30),
    resultado, medico_nome: 'Dra. Exemplo', medico_crm: '12345', arquivo: pdf(), ...(resultado === 'apto_restricao' ? { restricoes: 'Evitar esforço físico intenso' } : {}), ...extra } });
  for (const f of ['ana', 'carla', 'diego']) await cert(ids[f], ids.nr35, somarDias(HOJE, -60));
  await cert(ids.bruno, ids.nr35, somarMeses(HOJE, -25)); // venceu há 1 mês
  for (const f of ['elisa', 'fabio', 'gil']) await cert(ids[f], ids.nr33, somarDias(HOJE, -10));
  for (const f of ['ana', 'bruno', 'elisa', 'fabio', 'gil']) assert.equal((await aso(ids[f])).status, 201);
  await aso(ids.diego, 'apto_restricao');
});

after(async () => { if (amb) await amb.encerrar(); });

test('conferência: aponta cada problema de cada pessoa antes de emitir', async () => {
  const r = await api('POST', '/permissoes-trabalho/conferir', { token: tk.tecA, body: { tipo: 'altura', fim: instante(8),
    participantes: ['ana', 'bruno', 'carla', 'diego'].map((f) => ({ funcionario_id: ids[f], papel: 'executante' })) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, false);
  const de = (nome) => r.body.participantes.find((p) => p.funcionario === nome);
  assert.equal(de('Ana').ok, true);
  assert.ok(de('Ana').treinamentos[0].vencimento);
  assert.match(de('Bruno').problemas.join(), /NR-35 vencido/);
  assert.match(de('Carla').problemas.join(), /sem ASO/);
  assert.match(de('Diego').problemas.join(), /restrição/);
});

test('emissão: validações, recusa de quem não pode (registrada) e conferência guardada', async () => {
  const emitir = (body, token = tk.tecA) => api('POST', '/permissoes-trabalho', { token, body });
  const soAna = [{ funcionario_id: ids.ana, papel: 'executante' }];
  assert.equal((await emitir(altura(soAna), tk.consultaA)).status, 403);
  assert.equal((await emitir(altura(soAna, { fim: instante(13) }))).status, 400, 'mais de 12 horas');
  assert.equal((await emitir(altura(soAna, { inicio: instante(-2) }))).status, 400, 'começou há 2 horas');
  assert.equal((await emitir(altura(soAna, { checklist: { ...CHECK_ALTURA, ancoragem: false } }))).status, 409, 'item não atendido');
  assert.equal((await emitir(altura(soAna, { checklist: { ...CHECK_ALTURA, clima: undefined } }))).status, 400, 'item sem resposta');
  assert.equal((await emitir(altura(soAna, { checklist: { ...CHECK_ALTURA, isolamento: null } }))).status, 400, 'não se aplica sem explicação');
  assert.equal((await emitir(altura([{ funcionario_id: ids.ana, papel: 'vigia' }]))).status, 400, 'vigia não é papel de trabalho em altura');
  assert.equal((await emitir(altura([...soAna, { funcionario_id: ids.ana, papel: 'executante' }]))).status, 400, 'mesma pessoa duas vezes');

  const recusa = await emitir(altura([...soAna, { funcionario_id: ids.bruno, papel: 'executante' }]));
  assert.equal(recusa.status, 409);
  assert.deepEqual(recusa.body.participantes.map((p) => p.funcionario), ['Bruno']);
  assert.ok(await amb.knex('auditoria').where({ acao: 'pt_recusada' }).first(), 'a tentativa fica registrada');
  assert.equal((await api('GET', '/permissoes-trabalho', { token: tk.tecA })).body.length, 0, 'nada foi emitido');

  const ok = await emitir(altura(soAna, { checklist: { ...CHECK_ALTURA, isolamento: null }, medidas_adicionais: 'Telhado sem circulação de pessoas abaixo (área fechada)' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  ids.pt1 = ok.body.id;
  ids.codigo1 = ok.body.codigo_verificacao;
  assert.equal(ok.body.numero, `${HOJE.slice(0, 4)}/0001`);
  assert.equal(ok.body.status, 'aguardando_assinaturas');
  assert.equal(ok.body.participantes[0].conferencia.treinamentos[0].nr, 'NR-35');
  assert.equal(ok.body.participantes[0].conferencia.aso.resultado, 'apto');
  await assert.rejects(amb.knex('pt_participantes').where({ pt_id: ids.pt1 }).update({ papel: 'vigia' }), /só aceita inclusão/);
});

test('assinatura pelo crachá libera; verificação pública diz se pode trabalhar', async () => {
  const antes = await api('GET', `/verificar/${ids.codigo1}`);
  assert.equal(antes.body.pode_trabalhar, false, 'sem assinatura ainda');
  const assinar = (token, pin) => api('POST', `/permissoes-trabalho/${ids.pt1}/assinar`, { token: tk.tecA, body: { token, pin } });
  assert.equal((await assinar(await qr(ids.bruno), '7395')).status, 404, 'não é participante');
  assert.notEqual((await assinar(await qr(ids.ana), '1111')).status, 201, 'PIN errado');
  const r = await assinar(await qr(ids.ana), '7395');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.liberada, true);
  assert.equal(r.body.permissao.status, 'liberada');
  assert.equal((await assinar(await qr(ids.ana), '7395')).status, 409, 'assinatura única');

  const v = await api('GET', `/verificar/${ids.codigo1}`);
  assert.equal(v.body.tipo, 'permissao_trabalho');
  assert.equal(v.body.pode_trabalhar, true);
  assert.deepEqual(v.body.participantes, [{ iniciais: 'A.', papel: 'executante', assinou: true }]);
  const doc = await fetch(`${amb.base}/permissoes-trabalho/${ids.pt1}/pdf`, { headers: { Authorization: `Bearer ${tk.consultaA}` } });
  assert.equal(doc.status, 200);
  assert.equal(Buffer.from(await doc.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  await assert.rejects(amb.knex('pt_assinaturas').del(), /só aceita inclusão/);

  assert.equal((await api('POST', `/permissoes-trabalho/${ids.pt1}/encerrar`, { token: tk.tecA, body: { observacao: 'ok' } })).status, 400);
  const fim = await api('POST', `/permissoes-trabalho/${ids.pt1}/encerrar`, { token: tk.tecA, body: { observacao: 'Telhas trocadas, todos desceram, área liberada' } });
  assert.equal(fim.body.status, 'encerrada');
  assert.equal((await api('GET', `/verificar/${ids.codigo1}`)).body.pode_trabalhar, false);
});

test('espaço confinado: papéis, medição obrigatória e suspensão automática por atmosfera', async () => {
  const equipe = [{ funcionario_id: ids.elisa, papel: 'executante' }, { funcionario_id: ids.fabio, papel: 'vigia' }, { funcionario_id: ids.gil, papel: 'supervisor_entrada' }];
  const corpo = (extra = {}) => ({ filial_id: ids.A, tipo: 'espaco_confinado', local_descricao: 'Reservatório inferior de água', servico: 'Limpeza do reservatório',
    inicio: instante(0), fim: instante(6), checklist: CHECK_CONFINADO, participantes: equipe, medicao_inicial: { o2: 20.9, lie: 0, h2s: 0, co: 2, equipamento: 'Detector 4 gases SN 123' }, ...extra });
  const emitir = (b) => api('POST', '/permissoes-trabalho', { token: tk.tecA, body: b });
  assert.equal((await emitir(corpo({ participantes: equipe.slice(0, 2) }))).status, 400, 'sem supervisor de entrada');
  assert.equal((await emitir(corpo({ medicao_inicial: undefined }))).status, 400, 'sem medição');
  const baixo = await emitir(corpo({ medicao_inicial: { o2: 18.2, lie: 0 } }));
  assert.equal(baixo.status, 409);
  assert.match(baixo.body.error, /O2 18.2%/);
  assert.equal((await emitir(corpo({ participantes: [...equipe.slice(0, 2), { funcionario_id: ids.ana, papel: 'supervisor_entrada' }] }))).status, 409, 'Ana não tem NR-33');

  const ok = await emitir(corpo());
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const id = ok.body.id;
  assert.equal(ok.body.medicoes.length, 1);
  const gil = ok.body.participantes.find((p) => p.funcionario_id === ids.gil);
  assert.equal((await api('POST', `/pt-participantes/${gil.id}/assinatura-manual`, { token: tk.tecA, body: { observacao: 'Assinou a PET em papel no local' } })).status, 403, 'manual só gestão');
  assert.equal((await api('POST', `/pt-participantes/${gil.id}/assinatura-manual`, { token: tk.gestorA, body: { observacao: 'curta' } })).status, 400);
  assert.equal((await api('POST', `/pt-participantes/${gil.id}/assinatura-manual`, { token: tk.gestorA, body: { observacao: 'Assinou a PET em papel no local (celular sem sinal)' } })).status, 201);
  for (const f of ['elisa', 'fabio']) await api('POST', `/permissoes-trabalho/${id}/assinar`, { token: tk.tecA, body: { token: await qr(ids[f]), pin: '7395' } });
  assert.equal((await api('GET', `/permissoes-trabalho/${id}`, { token: tk.tecA })).body.status, 'liberada');

  const medir = (m) => api('POST', `/permissoes-trabalho/${id}/medicoes`, { token: tk.tecA, body: m });
  assert.equal((await medir({ o2: 20.8 })).status, 400, 'medição incompleta');
  assert.equal((await medir({ o2: 20.8, lie: 1 })).body.suspensa, false);
  const alerta = await medir({ o2: 20.5, lie: 12, equipamento: 'Detector 4 gases SN 123' });
  assert.equal(alerta.status, 201);
  assert.equal(alerta.body.suspensa, true);
  assert.equal(alerta.body.permissao.status, 'cancelada');
  assert.match(alerta.body.permissao.motivo_cancelamento, /LIE 12%/);
  assert.equal((await medir({ o2: 20.9, lie: 0 })).status, 409, 'suspensa não aceita mais nada');
});

test('exigências por papel definidas pela matriz substituem a NR do tipo', async () => {
  const definir = (token, treinamento_ids) => api('PUT', '/permissoes-trabalho/exigencias', { token, body: { tipo: 'altura', papel: 'executante', treinamento_ids } });
  assert.equal((await definir(tk.tecA, [ids.resgate])).status, 403);
  const r = await definir(tk.admin, [ids.nr35, ids.resgate]);
  assert.equal(r.status, 200);
  assert.equal(r.body.find((t) => t.tipo === 'altura').papeis[0].treinamentos.length, 2);
  const conferir = async () => (await api('POST', '/permissoes-trabalho/conferir', { token: tk.tecA, body: { tipo: 'altura', participantes: [{ funcionario_id: ids.ana, papel: 'executante' }] } })).body;
  assert.match((await conferir()).participantes[0].problemas.join(), /sem Resgate em altura/);
  await definir(tk.admin, []);
  assert.equal((await conferir()).ok, true, 'vazio: volta a valer a NR-35');
});

test('pendências: permissão vencida sem encerramento fica vermelha no semáforo', async () => {
  const r = await api('POST', '/permissoes-trabalho', { token: tk.tecA, body: altura([{ funcionario_id: ids.ana, papel: 'executante' }], { local_descricao: 'Fachada leste' }) });
  assert.equal(r.status, 201);
  await amb.knex('permissoes_trabalho').where({ id: r.body.id }).update({ inicio: new Date(Date.now() - 10 * 3600e3), fim: new Date(Date.now() - 2 * 3600e3) });
  const pend = (await api('GET', '/permissoes-trabalho/pendencias', { token: tk.consultaA })).body;
  assert.equal(pend.itens.find((i) => i.pt_id === r.body.id).situacao, 'vencida_sem_encerramento');
  assert.ok(!pend.itens.some((i) => i.pt_id === ids.pt1), 'encerrada não é pendência');
  assert.equal((await api('POST', `/permissoes-trabalho/${r.body.id}/assinar`, { token: tk.tecA, body: { token: await qr(ids.ana), pin: '7395' } })).status, 409, 'vencida não se assina');
  const painel = (await api('GET', `/painel/conformidade?filial_id=${ids.A}`, { token: tk.consultaA })).body.filiais[0];
  assert.equal(painel.modulos.permissoes.cor, 'vermelho');
  const rel = await fetch(`${amb.base}/relatorios/permissoes?todas=true`, { headers: { Authorization: `Bearer ${tk.gestorA}` } });
  assert.equal(rel.status, 200);
  assert.equal((await api('POST', `/permissoes-trabalho/${r.body.id}/cancelar`, { token: tk.tecA, body: { motivo: 'Serviço não realizado: chuva forte' } })).body.status, 'cancelada');
});
