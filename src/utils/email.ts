// Envío de correo con el RIDE (PDF) y el XML autorizado adjuntos.
//
// Usa SMTP genérico (nodemailer) en vez de un servicio de terceros: así
// funciona con cualquier cuenta de correo que el negocio ya tenga (Gmail con
// contraseña de aplicación, un correo corporativo, etc.), sin depender de una
// API paga ni de una cuenta nueva.
//
// A propósito, esto es "mejor esfuerzo": si el SMTP no está configurado, o el
// envío falla, NO debe romper el flujo de autorización del SRI — la factura
// ya quedó autorizada y eso es lo importante; el correo es una comodidad
// adicional para el cliente, no un requisito legal.

import nodemailer from "nodemailer";

function smtpConfigurado(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

function crearTransporte() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true", // true para el puerto 465, false para 587/25 (STARTTLS)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
}

export interface ComprobanteParaCorreo {
  destinatario: string;
  asunto: string;
  textoPlano: string;
  pdfBuffer: Buffer;
  pdfNombreArchivo: string;
  xmlContenido: string;
  xmlNombreArchivo: string;
}

// Devuelve true si se intentó enviar (SMTP configurado), false si se saltó
// silenciosamente por no haber SMTP configurado (para no confundir "no
// configurado" con "falló el envío" en los logs de quien llame a esto).
export async function enviarComprobantePorCorreo(datos: ComprobanteParaCorreo): Promise<boolean> {
  if (!smtpConfigurado()) {
    console.log(
      `[correo] SMTP no configurado (faltan SMTP_HOST/SMTP_USER/SMTP_PASSWORD en .env) — se omite el envío a ${datos.destinatario}.`
    );
    return false;
  }

  const transporte = crearTransporte();

  await transporte.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: datos.destinatario,
    subject: datos.asunto,
    text: datos.textoPlano,
    attachments: [
      {
        filename: datos.pdfNombreArchivo,
        content: datos.pdfBuffer,
        contentType: "application/pdf",
      },
      {
        filename: datos.xmlNombreArchivo,
        content: datos.xmlContenido,
        contentType: "application/xml",
      },
    ],
  });

  return true;
}

export interface DigestParaCorreo {
  destinatario: string; // admite varias direcciones separadas por coma
  asunto: string;
  textoPlano: string;
}

// Correo simple sin adjuntos — lo usa el resumen diario (ver
// jobs/resumenDiario.ts). Mismo criterio "mejor esfuerzo" que
// enviarComprobantePorCorreo: si el SMTP no está configurado, se omite sin
// lanzar error.
export async function enviarCorreoTextoPlano(datos: DigestParaCorreo): Promise<boolean> {
  if (!smtpConfigurado()) {
    console.log(
      `[correo] SMTP no configurado (faltan SMTP_HOST/SMTP_USER/SMTP_PASSWORD en .env) — se omite el envío a ${datos.destinatario}.`
    );
    return false;
  }

  const transporte = crearTransporte();
  await transporte.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: datos.destinatario,
    subject: datos.asunto,
    text: datos.textoPlano,
  });

  return true;
}
