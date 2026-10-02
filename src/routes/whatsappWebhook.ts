// Webhook de WhatsApp Business (Meta Cloud API). Además de la verificación
// GET que exige Meta, el POST ahora PROCESA los mensajes que mandan los
// clientes (ver utils/tickets.ts → procesarMensajeEntrante):
//  - una respuesta "1".."5" a una encuesta de satisfacción pendiente se
//    guarda como calificación de la visita técnica,
//  - cualquier otro mensaje abre un ticket de soporte (o se suma al ticket
//    que ese número ya tiene abierto).
//
// Público a propósito (nunca requireAuth) — Meta llama a esta URL
// directamente, sin token de este sistema. La verificación (GET) es lo que
// impide que cualquiera registre acá una URL ajena: solo Meta conoce
// WHATSAPP_WEBHOOK_VERIFY_TOKEN porque lo escribiste vos mismo al configurar
// el webhook en Meta Developer Console.
//
// Multiempresa: el webhook no trae token de este sistema, así que la empresa
// se identifica por el phone_number_id que viene en el evento — cada empresa
// tiene su propio número (EmpresaConfig.whatsappPhoneNumberId). Un evento de
// un número que ninguna empresa tiene configurado se ignora.
import { Router, Request, Response } from "express";
import * as crypto from "crypto";
import { ejecutarConEmpresa } from "../db";
import { listarEmpresas } from "../utils/empresas";
import { procesarMensajeEntrante } from "../utils/tickets";

export const whatsappWebhookRouter = Router();

whatsappWebhookRouter.get("/", (req: Request, res: Response) => {
  const modo = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const desafio = req.query["hub.challenge"];

  if (modo === "subscribe" && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(String(desafio));
    return;
  }
  res.sendStatus(403);
});

// Texto legible de cualquier tipo de mensaje — los que no son texto quedan
// como una marca para que quien atiende sepa que el cliente mandó algo
// (y lo mire en el celular de la empresa).
function textoDeMensaje(mensaje: any): string {
  switch (mensaje?.type) {
    case "text":
      return String(mensaje.text?.body ?? "");
    case "button":
      return String(mensaje.button?.text ?? "");
    case "interactive":
      return String(mensaje.interactive?.button_reply?.title ?? mensaje.interactive?.list_reply?.title ?? "");
    case "location":
      return `[Ubicación] https://maps.google.com/?q=${mensaje.location?.latitude},${mensaje.location?.longitude}`;
    case "image":
      return `[Imagen]${mensaje.image?.caption ? ` ${mensaje.image.caption}` : ""}`;
    case "audio":
      return "[Nota de voz]";
    case "video":
      return "[Video]";
    case "document":
      return `[Documento] ${mensaje.document?.filename ?? ""}`.trim();
    default:
      return `[Mensaje de tipo ${mensaje?.type ?? "desconocido"}]`;
  }
}

async function procesarEvento(cuerpo: any): Promise<void> {
  for (const entrada of cuerpo?.entry ?? []) {
    for (const cambio of entrada?.changes ?? []) {
      const valor = cambio?.value;
      const mensajes: any[] = valor?.messages ?? [];
      if (mensajes.length === 0) continue; // estados de entrega (sent/read), no mensajes

      const phoneNumberId = valor?.metadata?.phone_number_id;
      const empresa = listarEmpresas().find((e) => e.whatsappPhoneNumberId && e.whatsappPhoneNumberId === phoneNumberId);
      if (!empresa) {
        console.warn(`[whatsapp-webhook] Mensaje para el número ${phoneNumberId}, que ninguna empresa tiene configurado — se ignora.`);
        continue;
      }

      const nombres = new Map<string, string>((valor?.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const mensaje of mensajes) {
        try {
          await ejecutarConEmpresa(empresa.id, () =>
            procesarMensajeEntrante(String(mensaje.from), nombres.get(mensaje.from) ?? null, textoDeMensaje(mensaje))
          );
        } catch (error: any) {
          console.error(`[whatsapp-webhook] Error procesando un mensaje de ${mensaje.from} ("${empresa.nombre}"):`, error.message);
        }
      }
    }
  }
}

// Firma de Meta (cabecera X-Hub-Signature-256 = HMAC-SHA256 del cuerpo
// CRUDO con el App Secret de la app de Meta). Ahora que un POST acá crea
// tickets y guarda calificaciones, sin esto cualquiera que conozca la URL
// podría inyectar mensajes falsos. Si WHATSAPP_APP_SECRET no está en .env se
// acepta igual (compatibilidad con instalaciones que ya funcionaban), con
// una advertencia en el log.
let advertenciaSinSecretoMostrada = false;
function firmaValida(req: Request): boolean {
  const secreto = process.env.WHATSAPP_APP_SECRET;
  if (!secreto) {
    if (!advertenciaSinSecretoMostrada) {
      console.warn("[whatsapp-webhook] WHATSAPP_APP_SECRET no está configurado — no se verifica la firma de Meta. Configuralo en .env.");
      advertenciaSinSecretoMostrada = true;
    }
    return true;
  }
  const firma = req.header("x-hub-signature-256") ?? "";
  const cuerpoCrudo: Buffer | undefined = (req as any).rawBody;
  if (!cuerpoCrudo || !firma.startsWith("sha256=")) return false;
  const esperada = Buffer.from("sha256=" + crypto.createHmac("sha256", secreto).update(cuerpoCrudo).digest("hex"));
  const recibida = Buffer.from(firma);
  return esperada.length === recibida.length && crypto.timingSafeEqual(esperada, recibida);
}

whatsappWebhookRouter.post("/", (req: Request, res: Response) => {
  if (!firmaValida(req)) {
    console.warn("[whatsapp-webhook] Firma inválida — se descarta el evento.");
    res.sendStatus(401);
    return;
  }
  // Meta espera 200 rápido (si no, reintenta y eventualmente desactiva el
  // webhook) — por eso se responde de una y el procesamiento sigue después.
  res.sendStatus(200);
  procesarEvento(req.body).catch((error) => console.error("[whatsapp-webhook] Error inesperado:", error?.message));
});
