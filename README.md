# SESMT — Gestão de Segurança do Trabalho

Sistema web para o SESMT (Serviço Especializado em Segurança e Medicina do Trabalho) controlar a entrega de EPIs, o estoque e os custos, além de guardar a **comprovação legal** de tudo o que foi entregue e realizado, pensando em fiscalizações e em futuros processos trabalhistas.

## Sobre mim e o porquê deste projeto

Trabalho há **14 anos como Técnico em Segurança do Trabalho** e estou migrando para a área de tecnologia, cursando **Análise e Desenvolvimento de Sistemas (ADS)**.

Este projeto junta as duas coisas. Ele nasceu de problemas que vivi no dia a dia do SESMT:

- **Fichas de EPI em papel** que se perdem, ficam sem assinatura ou não comprovam a data da troca. Quando chega um processo, anos depois, falta a prova.
- **Controles espalhados em planilhas:** vencimento de treinamentos (NR-10, NR-35...), de ASOs, de extintores e de alvarás de PPCI, cada um num arquivo.
- **Custos sem histórico:** o preço pago por uma luva em 2020 não é o de hoje, e somar e dividir valores esconde o gasto real.

A ideia é usar o conhecimento técnico da área para construir uma ferramenta que um SESMT realmente usaria, e documentar aqui as decisões de desenvolvimento.

## O que já funciona

### Entrega de EPI com valor de prova

- **Assinatura por crachá QR + PIN pessoal.** O QR contém só uma chave aleatória (nunca CPF ou id). O funcionário cria o próprio PIN no primeiro acesso.
  - O PIN é guardado só como hash, e PINs fracos (1234, 1111) são recusados.
  - Após 5 tentativas erradas, o PIN fica bloqueado por 15 minutos.
- **Cada entrega grava as provas:**
  - CA vigente copiado para o registro, com bloqueio se o CA estiver vencido;
  - motivo, técnico, hora do servidor, IP e aparelho;
  - filial, setor e função do funcionário na data;
  - foto opcional, com SHA-256;
  - se havia termo de adesão naquele momento;
  - um código de verificação.
- **Verificação pública:** `/verificar/<código>` confirma que a entrega existe, mostrando só as iniciais do funcionário.
- **Termo de adesão à assinatura eletrônica:** o documento assinado é anexado (PDF ou foto), com hash.
- **Ficha de EPI em PDF (NR-6):** empregador, empregado, declaração, todas as entregas e o código de cada uma.
- **Leitor web** ([public/leitor.html](public/leitor.html)) para celular. Faz login, lê o crachá, cadastra o PIN, mostra só os EPIs com saldo e CA válido, tira a foto (reduzida antes do envio) e exibe o comprovante.

### Estoque com custo histórico

- **Estoque por filial, em lotes:** cada compra guarda o preço pago, o fornecedor, a nota (opcional) e a validade.
- **Custo pelo método PEPS:** cada saída usa o preço do lote de onde saiu. Se sobraram 10 luvas compradas em 2020 a R$ 2 e chegaram outras em 2026 a R$ 5, a entrega de 15 custa 10 × R$ 2 + 5 × R$ 5, e não 15 × a média. O valor gravado nunca muda depois.
- **Movimentações imutáveis:** entrada, entrega, descarte, ajuste de inventário e transferência. Erro se corrige com **estorno**, que devolve ao mesmo lote com o mesmo custo.
- **Lotes vencidos** não são entregues: aparecem separados no saldo, para descarte.
- **Transferência entre filiais:** a origem envia e o destino confirma o recebimento. O custo e a validade do lote original acompanham o material.
- **Saldos valorizados e alerta de estoque mínimo** por filial.
- **Concorrência segura:** os lotes são travados durante a saída, então duas entregas simultâneas não usam o mesmo saldo (há teste para isso).

### Estrutura e controle
- **Estrutura multi-filial:** matriz → filiais (cada uma com CNPJ próprio, UF, cidade e bairro) → prédios e setores. Funções num catálogo único do grupo.
- **Permissões por perfil e por filial:**

  | Perfil | O que faz |
  |---|---|
  | `admin` (matriz) | Tudo, em todas as filiais |
  | `gestor` | Cadastros da própria filial |
  | `tecnico` | Entregas e estoque |
  | `saude` | Dados de saúde |
  | `consulta` | Só leitura |

  Um usuário de uma filial não vê dados de outra, nem trocando o id na URL.
- **Histórico de lotação:** mudança de setor, função ou filial fecha o período anterior e abre um novo. Isso prova qual era a função do funcionário em cada data.
- **Nada com histórico é apagado:**
  - funcionários são desligados e EPIs, filiais e setores são inativados;
  - o banco recusa exclusões que levariam o histórico junto (`ON DELETE RESTRICT`).
- **Log de auditoria:** quem fez o quê, quando, de qual IP, com os dados antes e depois. Senhas e chaves de crachá nunca aparecem no log.
- **Validações:** CPF, CNPJ e UF; matrícula única por CNPJ; CPF único no grupo.
- **Autenticação com JWT** conferida no banco a cada requisição: um usuário desativado perde o acesso na hora.

## Em construção (roadmap)

O modelo completo está sendo desenhado junto com a rotina real de um SESMT com várias filiais:

1. ~~**Estrutura multi-filial** com permissões por filial~~ ✅ concluída
2. ~~**EPI com valor jurídico** e **estoque com custo histórico (PEPS)**~~ ✅ concluída
3. **Treinamentos:** exigências por função e lista de presença assinada com o crachá.
4. **ASOs (PCMSO):** controle de vencimentos, com acesso restrito aos dados de saúde (LGPD).
5. **PPCI por prédio:**
   - projeto aprovado e alvará;
   - comparação entre o que o projeto prevê e o que está instalado;
   - manutenção de extintores e inspeção mensal por QR no equipamento.
6. **Relatórios em todas as áreas:**
   - exportação em PDF e Excel, com código de verificação;
   - consulta da situação "como estava em uma data";
   - painel de conformidade.
7. **Encadeamento por hash e fechamento mensal:** reforça a prova de que nada foi alterado. A correção por estorno já está pronta.

## Tecnologias

- **Node.js** + **Express 5**
- **PostgreSQL** + **Knex** (migrations)
- **JWT** (`jsonwebtoken`) e **bcrypt** (`bcryptjs`) para autenticação
- **qrcode** para gerar os QR codes e **html5-qrcode** para a leitura pela câmera
- **Testes:** `node:test` + **embedded-postgres**, que roda os testes num PostgreSQL real e temporário, sem depender do banco online

## Como rodar

```bash
npm install
cp .env.example .env          # cole a DATABASE_URL do seu Postgres e gere o JWT_SECRET
npm run db:testar             # confere conexão, SSL e migrations pendentes (nunca mostra a senha)
npx knex migrate:latest
npm run criar-admin -- "Seu Nome" voce@exemplo.com "uma-senha-forte"
npm run dev
```

O leitor fica em `http://localhost:3000/leitor.html`. No celular, a câmera só abre por **HTTPS**: use o ambiente de produção ou um túnel (por exemplo, `npx localtunnel --port 3000`).

### Testes

```bash
npm test
```

O primeiro `npm test` baixa o PostgreSQL embutido. Cada execução:
- sobe um banco temporário;
- roda as migrations;
- testa permissões, filtragem por filial, lotação, auditoria e entregas;
- apaga tudo no fim.

## Principais rotas

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/login` | Login, devolve o token JWT e as filiais do usuário |
| GET | `/auth/me` | Usuário logado |
| GET/POST/PUT | `/usuarios` | Usuários e suas filiais (matriz) |
| GET/POST/PUT | `/filiais` | Filiais: CNPJ, UF, cidade, bairro (cadastro pela matriz) |
| GET/POST/PUT | `/predios`, `/setores` | Prédios e setores de cada filial |
| GET/POST/PUT | `/funcoes` | Catálogo de funções (matriz) |
| GET/POST/PUT | `/funcionarios` | Funcionários com filial, setor e função; desligamento via `status` |
| GET | `/funcionarios/:id/lotacoes` | Histórico de filial/setor/função |
| GET | `/funcionarios/:id/qrcode` | PNG do QR do crachá |
| GET | `/funcionarios/qr/:token` | Dados do funcionário, entregas e EPIs vencidos |
| GET/POST/PUT | `/epis` | Catálogo de EPIs com tamanhos e CA (matriz) |
| POST | `/epis/:id/cas`, `/epis/:id/itens` | Renovação de CA e novos tamanhos (matriz) |
| POST | `/funcionarios/qr/:token/pin` | Funcionário cadastra o próprio PIN (primeiro acesso) |
| DELETE | `/funcionarios/:id/pin` | Gestão reseta o PIN |
| POST | `/funcionarios/:id/termo` | Termo de adesão assinado (PDF/foto) |
| GET | `/funcionarios/:id/ficha-epi` | Ficha de EPI em PDF |
| POST | `/entregas/qr` | Entrega por QR + PIN (+ foto), baixa PEPS |
| POST | `/entregas` | Entrega manual com justificativa (gestão) |
| POST | `/entregas/:id/estorno` | Estorno de entrega (gestão) |
| GET | `/verificar/:codigo` | Verificação pública de uma entrega |
| POST | `/estoque/entradas` | Entrada de lote com preço pago |
| GET | `/estoque/saldos`, `/estoque/lotes`, `/estoque/movimentacoes` | Saldos valorizados, lotes e extrato |
| POST | `/estoque/descartes`, `/estoque/ajustes` | Descarte e ajuste de inventário |
| POST | `/estoque/movimentacoes/:id/estorno` | Estorno de entrada, descarte ou ajuste |
| PUT | `/estoque/minimos` | Estoque mínimo por filial |
| GET/POST | `/transferencias` (+ `/receber`, `/cancelar`) | Transferência entre filiais |
| GET/POST/PUT | `/fornecedores` | Fornecedores da filial |
| GET | `/auditoria` | Log de auditoria (matriz) |
| GET | `/status` | Saúde da API e do banco (público, para monitoramento) |
| GET/POST | `/treinamentos`, `/certificados`, `/acidentes` | Demais cadastros |

Todas as rotas, exceto `/ping` e `/auth/login`, exigem o cabeçalho `Authorization: Bearer <token>`.

## Autor

**[@Vinicasagrande87](https://github.com/Vinicasagrande87)**: Técnico em Segurança do Trabalho há 14 anos, estudante de Análise e Desenvolvimento de Sistemas.
