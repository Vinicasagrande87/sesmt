// Etapa 6: PPCI por prédio. Projeto aprovado com medidas, alvará, equipamentos com QR,
// manutenções (recarga/teste hidrostático), inspeção mensal pelo QR, comparação projeto x instalado e pendências.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias } = require('../src/utils/datas');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% documento de exemplo\n%%EOF').toString('base64');
const token = async (id) => (await amb.knex('equipamentos_incendio').where({ id }).first('qr_token')).qr_token;

const CHECK_EXTINTOR = { no_local: true, acesso_desobstruido: true, sinalizacao: true, lacre_intacto: true, manometro_na_faixa: true, selo_inmetro: true, mangueira_bico: true, corpo_sem_danos: true };

const equipamento = async (body, t = tk.tecA) => {
  const r = await api('POST', '/equipamentos-incendio', { token: t, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@t.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@t.com', 'senha-admin');
  const filial = async (nome, cnpj) => (await api('POST', '/filiais', { token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' } })).body.id;
  ids.A = await filial('Campus Exemplo', '11222333000181');
  ids.C = await filial('Colégio Exemplo', '11444777000161');
  const predio = async (filial_id, nome) => (await api('POST', '/predios', { token: tk.admin, body: { filial_id, nome, area_m2: 2500 } })).body.id;
  ids.p1 = await predio(ids.A, 'Prédio 1');
  ids.p2 = await predio(ids.A, 'Prédio 2');
  ids.p3 = await predio(ids.C, 'Prédio Colégio');
  for (const [nome, perfil, filiais] of [['tecA', 'tecnico', [ids.A]], ['gestorA', 'gestor', [ids.A]], ['consultaA', 'consulta', [ids.A]], ['tecC', 'tecnico', [ids.C]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome: `Usuário ${nome}`, email: `${nome}@t.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@t.com`, 'senha1234');
  }
});

after(async () => { if (amb) await amb.encerrar(); });

test('PPCI: projeto aprovado com medidas; validações e permissões', async () => {
  const corpo = (extra = {}) => ({
    predio_id: ids.p1, data_aprovacao: somarDias(HOJE, -400), numero_processo: '1234/2024', responsavel_nome: 'Eng. Fulano', responsavel_registro: 'CREA-RS 000000',
    arquivo: pdf(),
    medidas: [
      { tipo: 'extintor', agente: 'pqs_abc', quantidade: 3, especificacao: 'PQS ABC 4 kg' },
      { tipo: 'extintor', agente: 'co2', quantidade: 1, especificacao: 'CO2 6 kg (casa de máquinas)' },
      { tipo: 'hidrante', quantidade: 1 },
      { tipo: 'saida_emergencia', especificacao: '2 saídas, escada protegida' },
      { tipo: 'brigada', especificacao: '6 brigadistas por turno' }
    ],
    ...extra
  });
  assert.equal((await api('POST', '/ppcis', { token: tk.consultaA, body: corpo() })).status, 403, 'consulta não registra');
  assert.equal((await api('POST', '/ppcis', { token: tk.tecC, body: corpo() })).status, 404, 'outra filial não enxerga o prédio');
  assert.equal((await api('POST', '/ppcis', { token: tk.tecA, body: corpo({ medidas: [{ tipo: 'extintor', agente: 'co2' }] }) })).status, 400, 'extintor sem quantidade');
  assert.equal((await api('POST', '/ppcis', { token: tk.tecA, body: corpo({ medidas: [{ tipo: 'hidrante', agente: 'co2', quantidade: 1 }] }) })).status, 400, 'agente em hidrante');
  assert.equal((await api('POST', '/ppcis', { token: tk.tecA, body: corpo({ medidas: [] }) })).status, 400, 'sem medidas');
  assert.equal((await api('POST', '/ppcis', { token: tk.tecA, body: corpo({ data_aprovacao: somarDias(HOJE, 1) }) })).status, 400, 'data futura');

  const r = await api('POST', '/ppcis', { token: tk.tecA, body: corpo() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.medidas.length, 5);
  assert.equal(r.body.orgao, 'Corpo de Bombeiros');
  ids.ppci = r.body.id;

  const arq = await fetch(`${amb.base}/ppcis/${ids.ppci}/arquivo`, { headers: { Authorization: `Bearer ${tk.consultaA}` } });
  assert.equal(arq.status, 200);
  assert.equal(arq.headers.get('content-type'), 'application/pdf');
  assert.equal((await api('GET', `/ppcis/${ids.ppci}`, { token: tk.tecC })).status, 404);
  assert.equal((await api('GET', '/ppcis', { token: tk.tecC })).body.length, 0);
});

test('alvará: validade, situação "vencendo" e ligação com o PPCI do mesmo prédio', async () => {
  const corpo = (extra = {}) => ({ predio_id: ids.p1, tipo_documento: 'APPCI', numero: '9999', data_emissao: somarDias(HOJE, -300), data_validade: somarDias(HOJE, 60), arquivo: pdf(), ...extra });
  assert.equal((await api('POST', '/alvaras', { token: tk.tecA, body: corpo({ data_validade: somarDias(HOJE, -400) }) })).status, 400, 'validade antes da emissão');
  assert.equal((await api('POST', '/alvaras', { token: tk.tecA, body: corpo({ predio_id: ids.p2, ppci_id: ids.ppci }) })).status, 400, 'PPCI de outro prédio');
  const r = await api('POST', '/alvaras', { token: tk.tecA, body: corpo({ ppci_id: ids.ppci }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.situacao, 'vencendo', 'vence em 60 dias: dentro do aviso de 90');
  ids.alvara = r.body.id;
  const lista = await api('GET', `/alvaras?predio_id=${ids.p1}`, { token: tk.consultaA });
  assert.equal(lista.body[0].situacao, 'vencendo');
});

test('equipamentos: cadastro com manutenções, identificação única por filial e permissões', async () => {
  assert.equal((await api('POST', '/equipamentos-incendio', { token: tk.tecA, body: { predio_id: ids.p1, tipo: 'extintor', identificacao: 'X', localizacao: 'Hall' } })).status, 400, 'extintor sem agente');
  assert.equal((await api('POST', '/equipamentos-incendio', { token: tk.tecA, body: { predio_id: ids.p1, tipo: 'canhao', identificacao: 'X', localizacao: 'Hall' } })).status, 400);
  assert.equal((await api('POST', '/equipamentos-incendio', { token: tk.tecC, body: { predio_id: ids.p1, tipo: 'hidrante', identificacao: 'X', localizacao: 'Hall' } })).status, 404);

  const e1 = await equipamento({
    predio_id: ids.p1, tipo: 'extintor', agente: 'pqs_abc', capacidade: '4 kg', identificacao: 'EXT-001', localizacao: 'Térreo, hall dos elevadores', ano_fabricacao: 2022,
    manutencoes: [
      { tipo: 'recarga', data_servico: somarDias(HOJE, -300), data_proxima: somarDias(HOJE, 10), empresa: 'Recarga Exemplo Ltda', numero_selo: 'SELO-1' },
      { tipo: 'teste_hidrostatico', data_servico: somarDias(HOJE, -300) }
    ]
  });
  assert.equal(e1.manutencoes.length, 2);
  assert.equal(e1.qr_token, undefined, 'o token não sai na API, só no QR');
  ids.e1 = e1.id;
  ids.e2 = (await equipamento({ predio_id: ids.p1, tipo: 'extintor', agente: 'pqs_abc', identificacao: 'EXT-002', localizacao: '1º andar, corredor', ano_fabricacao: 2019 })).id;
  ids.co2 = (await equipamento({ predio_id: ids.p1, tipo: 'extintor', agente: 'co2', identificacao: 'EXT-003', localizacao: 'Casa de máquinas',
    manutencoes: [{ tipo: 'recarga', data_servico: somarDias(HOJE, -30) }, { tipo: 'teste_hidrostatico', data_servico: somarDias(HOJE, -30) }] })).id;
  ids.hid = (await equipamento({ predio_id: ids.p1, tipo: 'hidrante', identificacao: 'HID-01', localizacao: 'Escada, térreo', manutencoes: [{ tipo: 'manutencao', data_servico: somarDias(HOJE, -10) }] })).id;
  ids.luz = (await equipamento({ predio_id: ids.p1, tipo: 'iluminacao_emergencia', identificacao: 'ILU-01', localizacao: 'Corredor' })).id;

  const dup = await api('POST', '/equipamentos-incendio', { token: tk.tecA, body: { predio_id: ids.p2, tipo: 'hidrante', identificacao: 'EXT-001', localizacao: 'x' } });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /identificação/);
  const recargaErrada = await api('POST', '/equipamentos-incendio', { token: tk.tecA, body: { predio_id: ids.p1, tipo: 'hidrante', identificacao: 'HID-09', localizacao: 'x', manutencoes: [{ tipo: 'recarga', data_servico: HOJE }] } });
  assert.equal(recargaErrada.status, 400);
  assert.match(recargaErrada.body.error, /^Manutenção 1:/);
  assert.equal((await api('GET', '/equipamentos-incendio', { token: tk.tecA })).body.filter((e) => e.identificacao === 'HID-09').length, 0, 'tudo ou nada');

  const png = await fetch(`${amb.base}/equipamentos-incendio/${ids.e1}/qrcode`, { headers: { Authorization: `Bearer ${tk.tecA}` } });
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');

  const show = await api('GET', `/equipamentos-incendio/${ids.e2}`, { token: tk.consultaA });
  assert.equal(show.status, 200);
  assert.equal(show.body.manutencoes.length, 0);
  assert.equal(show.body.checklist.length, 8);
});

test('inspeção mensal pelo QR: checklist completo, não conformidade explicada, uma por dia, código verificável', async () => {
  const t1 = await token(ids.e1);
  const lido = await api('GET', `/equipamentos-incendio/qr/${t1}`, { token: tk.tecA });
  assert.equal(lido.status, 200);
  assert.equal(lido.body.identificacao, 'EXT-001');
  assert.equal(lido.body.predio, 'Prédio 1');
  assert.equal(lido.body.inspecionado_hoje, false);
  assert.equal((await api('GET', `/equipamentos-incendio/qr/${t1}`, { token: tk.tecC })).status, 404, 'outra filial');
  assert.equal((await api('GET', `/equipamentos-incendio/qr/${t1}`, { token: tk.consultaA })).status, 403);

  const incompleto = await api('POST', '/equipamentos-incendio/inspecao', { token: tk.tecA, body: { token: t1, itens: { no_local: true } } });
  assert.equal(incompleto.status, 400);
  assert.ok(incompleto.body.faltando.includes('lacre_intacto'));
  const semExplicar = await api('POST', '/equipamentos-incendio/inspecao', { token: tk.tecA, body: { token: t1, itens: { ...CHECK_EXTINTOR, lacre_intacto: false } } });
  assert.equal(semExplicar.status, 400);

  const ok = await api('POST', '/equipamentos-incendio/inspecao', { token: tk.tecA, body: { token: t1, itens: CHECK_EXTINTOR } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.conforme, true);
  assert.equal(ok.body.metodo, 'qr');
  assert.equal(ok.body.localizacao, 'Térreo, hall dos elevadores');
  assert.equal((await api('POST', '/equipamentos-incendio/inspecao', { token: tk.tecA, body: { token: t1, itens: CHECK_EXTINTOR } })).status, 409, 'uma por dia');

  const v = await api('GET', `/verificar/${ok.body.codigo_verificacao}`);
  assert.equal(v.status, 200);
  assert.equal(v.body.tipo, 'inspecao_equipamento_incendio');
  assert.equal(v.body.resultado, 'conforme');
  assert.equal(v.body.inspetor, 'U. T.');

  // Não conforme no EXT-002, com observação (e o CO2 não tem manômetro: null = não se aplica)
  const ruim = await api('POST', '/equipamentos-incendio/inspecao', {
    token: tk.tecA, body: { token: await token(ids.e2), itens: { ...CHECK_EXTINTOR, lacre_intacto: false }, observacao: 'Lacre rompido, solicitar recarga' }
  });
  assert.equal(ruim.status, 201);
  assert.equal(ruim.body.conforme, false);
  const co2 = await api('POST', '/equipamentos-incendio/inspecao', { token: tk.tecA, body: { token: await token(ids.co2), itens: { ...CHECK_EXTINTOR, manometro_na_faixa: null } } });
  assert.equal(co2.status, 201);
  assert.equal(co2.body.conforme, true);

  // Sem QR: só com justificativa
  assert.equal((await api('POST', `/equipamentos-incendio/${ids.hid}/inspecoes`, { token: tk.tecA, body: { itens: { no_local: true, acesso_desobstruido: true, sinalizacao: true, abrigo_conservado: true, mangueiras_acondicionadas: true, esguicho_chave: true, registro_sem_vazamento: true } } })).status, 400);
  const manual = await api('POST', `/equipamentos-incendio/${ids.hid}/inspecoes`, {
    token: tk.tecA, body: { itens: { no_local: true, acesso_desobstruido: true, sinalizacao: true, abrigo_conservado: true, mangueiras_acondicionadas: true, esguicho_chave: true, registro_sem_vazamento: true }, observacao: 'Etiqueta do QR arrancada; nova etiqueta solicitada' }
  });
  assert.equal(manual.status, 201);
  assert.equal(manual.body.metodo, 'manual');

  // Anulação (gestão) libera nova inspeção no mesmo dia
  assert.equal((await api('POST', `/equipamento-inspecoes/${ok.body.id}/anular`, { token: tk.tecA, body: { motivo: 'Lançada no equipamento errado' } })).status, 403);
  assert.equal((await api('POST', `/equipamento-inspecoes/${ok.body.id}/anular`, { token: tk.gestorA, body: { motivo: 'Lançada no equipamento errado' } })).status, 201);
  assert.equal((await api('GET', `/verificar/${ok.body.codigo_verificacao}`)).body.anulada, true);
  assert.equal((await api('POST', '/equipamentos-incendio/inspecao', { token: tk.tecA, body: { token: t1, itens: CHECK_EXTINTOR } })).status, 201);
});

test('painel do prédio: projeto x instalado e situação de cada equipamento', async () => {
  const r = await api('GET', `/predios/${ids.p1}/ppci`, { token: tk.consultaA });
  assert.equal(r.status, 200);
  assert.equal(r.body.ppci.id, ids.ppci);
  assert.equal(r.body.situacao_alvara, 'vencendo');
  const linha = (tipo, agente) => r.body.comparacao.find((c) => c.tipo === tipo && (c.agente || null) === (agente || null));
  assert.deepEqual([linha('extintor', 'pqs_abc').previsto, linha('extintor', 'pqs_abc').instalado, linha('extintor', 'pqs_abc').situacao], [3, 2, 'faltando']);
  assert.equal(linha('extintor', 'co2').situacao, 'ok');
  assert.equal(linha('hidrante').situacao, 'ok');
  assert.equal(linha('saida_emergencia').situacao, 'nao_controlado');
  assert.equal(linha('iluminacao_emergencia').situacao, 'fora_do_projeto');

  const eq = (id) => r.body.equipamentos.find((e) => e.id === id);
  assert.deepEqual(eq(ids.e1).pendencias, ['recarga_vencendo']);
  assert.equal(eq(ids.e1).manutencoes.recarga.numero_selo, 'SELO-1');
  assert.deepEqual(eq(ids.e2).pendencias.sort(), ['nao_conforme', 'recarga_nao_registrada', 'teste_hidrostatico_vencida']);
  assert.equal(eq(ids.e2).manutencoes.teste_hidrostatico.estimada, true, '5 anos a partir do ano de fabricação');
  assert.deepEqual(eq(ids.co2).pendencias, []);
  assert.deepEqual(eq(ids.luz).pendencias, ['inspecao_atrasada'], 'nunca inspecionada; manutenção não é obrigatória');
  assert.equal((await api('GET', `/predios/${ids.p1}/ppci`, { token: tk.tecC })).status, 404);
});

test('pendências por filial: prédio sem PPCI/alvará, divergência e equipamentos', async () => {
  const r = await api('GET', `/ppci/pendencias?filial_id=${ids.A}`, { token: tk.gestorA });
  assert.equal(r.status, 200);
  const tem = (predio_id, situacao, extra = {}) => r.body.itens.some((i) => i.predio_id === predio_id && i.situacao === situacao && Object.entries(extra).every(([k, v]) => i[k] === v));
  assert.ok(tem(ids.p2, 'sem_ppci'));
  assert.ok(tem(ids.p2, 'sem_alvara'));
  assert.ok(tem(ids.p1, 'alvara_vencendo'));
  assert.ok(tem(ids.p1, 'divergencia_projeto'));
  assert.ok(tem(ids.p1, 'recarga_vencendo', { identificacao: 'EXT-001', data_limite: somarDias(HOJE, 10) }));
  assert.ok(tem(ids.p1, 'nao_conforme', { identificacao: 'EXT-002' }));
  assert.ok(tem(ids.p1, 'teste_hidrostatico_vencida', { identificacao: 'EXT-002', data_limite: '2024-01-01' }));
  assert.equal(r.body.resumo.sem_ppci, 1);
  const so = await api('GET', '/ppci/pendencias?situacao=nao_conforme', { token: tk.gestorA });
  assert.equal(so.body.itens.length, 1);
  assert.equal((await api('GET', '/ppci/pendencias?situacao=inventada', { token: tk.gestorA })).status, 400);
  assert.equal((await api('GET', '/ppci/pendencias', { token: tk.tecC })).body.itens.filter((i) => i.filial_id === ids.A).length, 0);
  // Nova recarga resolve a pendência
  assert.equal((await api('POST', `/equipamentos-incendio/${ids.e2}/manutencoes`, { token: tk.tecA, body: { tipo: 'recarga', data_servico: HOJE, numero_selo: 'SELO-2' } })).status, 201);
  const depois = await api('GET', `/equipamentos-incendio/${ids.e2}`, { token: tk.tecA });
  assert.equal(depois.body.manutencoes[0].data_proxima.slice(0, 10) >= somarDias(HOJE, 360), true);
  assert.ok(!depois.body.pendencias.includes('recarga_nao_registrada'));
});

test('baixa do equipamento (gestão), mudança de prédio e anulação do PPCI', async () => {
  assert.equal((await api('PUT', `/equipamentos-incendio/${ids.e2}`, { token: tk.tecA, body: { ativo: false, motivo_baixa: 'Condenado no teste' } })).status, 403);
  assert.equal((await api('PUT', `/equipamentos-incendio/${ids.e2}`, { token: tk.gestorA, body: { ativo: false } })).status, 400);
  assert.equal((await api('PUT', `/equipamentos-incendio/${ids.e2}`, { token: tk.gestorA, body: { ativo: false, motivo_baixa: 'Condenado no teste hidrostático' } })).status, 200);
  assert.equal((await api('POST', '/equipamentos-incendio/inspecao', { token: tk.tecA, body: { token: await token(ids.e2), itens: CHECK_EXTINTOR } })).status, 409);
  assert.ok(!(await api('GET', '/equipamentos-incendio', { token: tk.tecA })).body.some((e) => e.id === ids.e2));
  assert.ok((await api('GET', '/equipamentos-incendio?incluir_baixados=true', { token: tk.tecA })).body.some((e) => e.id === ids.e2));

  assert.equal((await api('PUT', `/equipamentos-incendio/${ids.luz}`, { token: tk.tecA, body: { predio_id: ids.p3 } })).status, 404, 'prédio de outra filial');
  const mudou = await api('PUT', `/equipamentos-incendio/${ids.luz}`, { token: tk.tecA, body: { predio_id: ids.p2, localizacao: 'Saguão' } });
  assert.equal(mudou.status, 200);
  assert.equal(mudou.body.predio_id, ids.p2);

  const painel = await api('GET', `/predios/${ids.p1}/ppci`, { token: tk.tecA });
  const abc = painel.body.comparacao.find((c) => c.agente === 'pqs_abc');
  assert.equal(abc.instalado, 1, 'baixado não conta como instalado');
  assert.ok(!painel.body.comparacao.some((c) => c.situacao === 'fora_do_projeto'));

  assert.equal((await api('POST', `/ppcis/${ids.ppci}/anular`, { token: tk.gestorA, body: { motivo: 'Lançado com o arquivo errado' } })).status, 201);
  const sem = await api('GET', `/predios/${ids.p1}/ppci`, { token: tk.tecA });
  assert.equal(sem.body.ppci, null);
  assert.deepEqual(sem.body.comparacao, []);
  assert.equal((await api('GET', `/ppcis?predio_id=${ids.p1}&incluir_anulados=true`, { token: tk.tecA })).body[0].anulado, true);
  const aud = await amb.knex('auditoria').where({ acao: 'anular_ppci' }).first();
  assert.ok(aud);
});
