// Envio de e-mail (SMTP via nodemailer). Configuração só no .env: SMTP_HOST, SMTP_PORT, SMTP_SECURE,
// SMTP_USER, SMTP_PASS e EMAIL_REMETENTE. Sem SMTP_HOST, o envio fica desligado (e avisa).
const nodemailer = require('nodemailer');

let transporte = null;
let configurado = false;

function obterTransporte() {
  if (configurado) return transporte;
  configurado = true;
  if (!process.env.SMTP_HOST) return null;
  transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',              // true = porta 465 (TLS direto)
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transporte;
}

const emailAtivo = () => !!obterTransporte();

// Para testes: troca o transporte por um objeto com sendMail(mensagem)
function definirTransporte(t) {
  transporte = t;
  configurado = true;
}

async function enviarEmail({ para, assunto, texto, html }) {
  const t = obterTransporte();
  if (!t) throw new Error('Envio de e-mail não configurado (SMTP_HOST vazio no .env)');
  return t.sendMail({
    from: process.env.EMAIL_REMETENTE || process.env.SMTP_USER,
    to: para, subject: assunto, text: texto, html
  });
}

module.exports = { enviarEmail, emailAtivo, definirTransporte };
