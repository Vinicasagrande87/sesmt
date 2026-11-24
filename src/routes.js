const express = require('express');
const routes = express.Router();

const FilialController = require('./controllers/FilialController');
const PredioController = require('./controllers/PredioController');
const SetorController = require('./controllers/SetorController');
const FuncaoController = require('./controllers/FuncaoController');
const FuncionarioController = require('./controllers/FuncionarioController');
const EpiController = require('./controllers/EpiController');
const EntregaController = require('./controllers/EntregaController');
const EstoqueController = require('./controllers/EstoqueController');
const FornecedorController = require('./controllers/FornecedorController');
const TransferenciaController = require('./controllers/TransferenciaController');
const ArquivoController = require('./controllers/ArquivoController');
const AcidenteController = require('./controllers/AcidenteController');
const TreinamentoController = require('./controllers/TreinamentoController');
const CertificadoController = require('./controllers/CertificadoController');
const AuthController = require('./controllers/AuthController');
const UsuarioController = require('./controllers/UsuarioController');
const AuditoriaController = require('./controllers/AuditoriaController');
const TurmaController = require('./controllers/TurmaController');
const VerificacaoController = require('./controllers/VerificacaoController');
const AsoController = require('./controllers/AsoController');
const PgrController = require('./controllers/PgrController');
const OrdemServicoController = require('./controllers/OrdemServicoController');
const { autenticar, permitir } = require('./middlewares/auth');

// Quem pode o quê (o filtro por filial é feito dentro de cada controller)
const matriz = permitir('admin');                                   // catálogos, filiais, usuários
const gestao = permitir('admin', 'gestor');                         // cadastros da filial, ajustes e estornos
const operacao = permitir('admin', 'gestor', 'tecnico');            // entregas, estoque, registros
const cadastroPessoal = permitir('admin', 'gestor', 'tecnico', 'saude'); // ver ficha / QR do funcionário
const saude = permitir('admin', 'saude');                           // ASOs (dado de saúde, LGPD)

// Rotas públicas
routes.get('/ping', (req, res) => res.json({ message: 'pong' }));
routes.post('/auth/login', AuthController.login);
routes.get('/verificar/:codigo', VerificacaoController.verificar);

// Daqui para baixo, tudo exige "Authorization: Bearer <token>".
// Sem perfil explícito = qualquer usuário logado (somente leitura, filtrada pelas suas filiais).
routes.use(autenticar);

routes.get('/auth/me', AuthController.me);

// Usuários e auditoria (matriz)
routes.get('/usuarios', matriz, UsuarioController.index);
routes.post('/usuarios', matriz, UsuarioController.create);
routes.put('/usuarios/:id', matriz, UsuarioController.update);
routes.get('/auditoria', matriz, AuditoriaController.index);

// Estrutura
routes.get('/filiais', FilialController.index);
routes.get('/filiais/:id', FilialController.show);
routes.post('/filiais', matriz, FilialController.create);
routes.put('/filiais/:id', matriz, FilialController.update);

routes.get('/predios', PredioController.index);
routes.post('/predios', gestao, PredioController.create);
routes.put('/predios/:id', gestao, PredioController.update);

routes.get('/setores', SetorController.index);
routes.post('/setores', gestao, SetorController.create);
routes.put('/setores/:id', gestao, SetorController.update);

routes.get('/funcoes', FuncaoController.index);
routes.post('/funcoes', matriz, FuncaoController.create);
routes.put('/funcoes/:id', matriz, FuncaoController.update);

// Funcionários
routes.get('/funcionarios', FuncionarioController.index);
routes.post('/funcionarios', gestao, FuncionarioController.create);
routes.get('/funcionarios/qr/:token', operacao, FuncionarioController.buscarPorToken);
routes.post('/funcionarios/qr/:token/pin', operacao, FuncionarioController.cadastrarPinPorQr);
routes.get('/funcionarios/:id', FuncionarioController.show);
routes.put('/funcionarios/:id', gestao, FuncionarioController.update);
routes.get('/funcionarios/:id/lotacoes', FuncionarioController.lotacoes);
routes.get('/funcionarios/:id/qrcode', cadastroPessoal, FuncionarioController.qrcode);
routes.delete('/funcionarios/:id/pin', gestao, FuncionarioController.resetarPin);
routes.post('/funcionarios/:id/termo', gestao, FuncionarioController.registrarTermo);
routes.get('/funcionarios/:id/ficha-epi', FuncionarioController.fichaEpi);

// Catálogo de EPIs (matriz)
routes.get('/epis', EpiController.index);
routes.get('/epis/:id', EpiController.show);
routes.post('/epis', matriz, EpiController.create);
routes.put('/epis/:id', matriz, EpiController.update);
routes.post('/epis/:id/cas', matriz, EpiController.adicionarCa);
routes.post('/epis/:id/itens', matriz, EpiController.adicionarItem);
routes.put('/epi-itens/:id', matriz, EpiController.alterarItem);

// Estoque por filial
routes.get('/fornecedores', FornecedorController.index);
routes.post('/fornecedores', gestao, FornecedorController.create);
routes.put('/fornecedores/:id', gestao, FornecedorController.update);

routes.get('/estoque/saldos', EstoqueController.saldos);
routes.get('/estoque/disponivel', operacao, EstoqueController.disponivel);
routes.get('/estoque/lotes', EstoqueController.lotes);
routes.get('/estoque/movimentacoes', EstoqueController.movimentacoes);
routes.post('/estoque/entradas', operacao, EstoqueController.entrada);
routes.post('/estoque/descartes', operacao, EstoqueController.descarte);
routes.post('/estoque/ajustes', gestao, EstoqueController.ajuste);
routes.post('/estoque/movimentacoes/:id/estorno', gestao, EstoqueController.estornar);
routes.put('/estoque/minimos', gestao, EstoqueController.definirMinimo);

routes.get('/transferencias', TransferenciaController.index);
routes.post('/transferencias', operacao, TransferenciaController.enviar);
routes.post('/transferencias/:id/receber', operacao, TransferenciaController.receber);
routes.post('/transferencias/:id/cancelar', operacao, TransferenciaController.cancelar);

// Entregas
routes.get('/entregas', EntregaController.index);
routes.post('/entregas/qr', operacao, EntregaController.createPorQr);
routes.post('/entregas', gestao, EntregaController.create);
routes.post('/entregas/:id/estorno', gestao, EntregaController.estornar);
routes.get('/entregas/:id/foto', EntregaController.foto);

routes.get('/arquivos/:id', ArquivoController.show);

// Treinamentos: catálogo e exigências por função (matriz), turmas, presença e capacitações
routes.get('/treinamentos', TreinamentoController.index);
routes.get('/treinamentos/pendencias', CertificadoController.pendencias);
routes.post('/treinamentos', matriz, TreinamentoController.create);
routes.put('/treinamentos/:id', matriz, TreinamentoController.update);
routes.get('/funcoes/:id/treinamentos', TreinamentoController.exigidosDaFuncao);
routes.put('/funcoes/:id/treinamentos', matriz, TreinamentoController.definirExigidos);

routes.get('/turmas', TurmaController.index);
routes.get('/turmas/:id', TurmaController.show);
routes.post('/turmas', operacao, TurmaController.create);
routes.put('/turmas/:id', operacao, TurmaController.update);
routes.post('/turmas/:id/presencas', operacao, TurmaController.presencaQr);
routes.post('/turmas/:id/presencas/manual', gestao, TurmaController.presencaManual);
routes.post('/presencas/:id/anular', gestao, TurmaController.anularPresenca);
routes.post('/turmas/:id/cancelar', gestao, TurmaController.cancelar);
routes.post('/turmas/:id/encerrar', operacao, TurmaController.encerrar);
routes.get('/turmas/:id/lista-presenca', TurmaController.listaPresencaPdf);

routes.get('/certificados', CertificadoController.index);
routes.post('/certificados', operacao, CertificadoController.createExterno);
routes.post('/certificados/:id/anular', gestao, CertificadoController.anular);
routes.get('/certificados/:id/pdf', CertificadoController.pdf);

// ASOs (NR-7): detalhes e PDF só para saude/admin; os demais veem apenas apto/inapto e vencimento
routes.get('/asos', AsoController.index);
routes.get('/asos/pendencias', AsoController.pendencias);
routes.post('/asos', saude, AsoController.create);
routes.post('/asos/:id/anular', saude, AsoController.anular);
routes.get('/asos/:id/arquivo', saude, AsoController.arquivo);

// PGR da filial e ordens de serviço (NR-1)
routes.get('/pgrs', PgrController.index);
routes.get('/pgrs/:id', PgrController.show);
routes.get('/pgrs/:id/arquivo', PgrController.arquivo);
routes.post('/pgrs', operacao, PgrController.create);
routes.put('/pgrs/:id', operacao, PgrController.update);
routes.post('/pgrs/:id/grupos', operacao, PgrController.adicionarGrupos);
routes.put('/pgr-grupos/:id', operacao, PgrController.alterarGrupo);
routes.delete('/pgr-grupos/:id', operacao, PgrController.removerGrupo);
routes.post('/pgrs/:id/publicar', operacao, PgrController.publicar);
routes.post('/pgrs/:id/revisar', operacao, PgrController.revisar);

routes.get('/funcionarios/:id/ordem-servico', OrdemServicoController.doFuncionario);
routes.get('/ordens-servico/pendencias', OrdemServicoController.pendencias);
routes.post('/ordens-servico/ciencia', operacao, OrdemServicoController.cienciaQr);
routes.get('/ordens-servico/:id/pdf', OrdemServicoController.pdf);
routes.post('/ordens-servico/:id/ciencias/manual', gestao, OrdemServicoController.cienciaManual);
routes.post('/os-ciencias/:id/anular', gestao, OrdemServicoController.anularCiencia);

// Acidentes
routes.get('/acidentes', AcidenteController.index);
routes.post('/acidentes', operacao, AcidenteController.create);

module.exports = routes;
