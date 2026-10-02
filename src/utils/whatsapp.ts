// Envío de plantillas de WhatsApp Business (Meta Cloud API) — hoy solo lo usa
// el recordatorio de próximo vencimiento de internet (ver
// jobs/recordatorioVencimientoInternet.ts). Mismo criterio "mejor esfuerzo"
// que utils/email.ts: si falla el envío, nunca debe romper el job que lo
// llama — el peor caso es que ese cliente puntual no recibe el recordatorio
// esta vez, no que se caiga el resto del ciclo.
//
// A diferencia de SMTP (una sola cuenta para TODAS las empresas, ver
// utils/email.ts), las credenciales acá SIEMPRE vienen de la empresa que
// llama (accessToken/phoneNumberId son parámetros, nunca process.env) — cada
// empresa manda desde su propio número de WhatsApp Business, con su propia
// cuenta de Meta (ver EmpresaConfig en utils/empresas.ts). Un número
// compartido entre empresas distintas haría que los clientes de una reciban
// mensajes "de" otra.
//
// WhatsApp NO permite mandar texto libre a un número que no te escribió
// primero dentro de las últimas 24 horas — fuera de esa ventana (que es
// SIEMPRE el caso acá, es el sistema el que inicia el contacto) solo se
// puede mandar una PLANTILLA ya aprobada por Meta (Meta Business Manager >
// WhatsApp > Message Templates, categoría "Utility").
import axios from "axios";

const GRAPH_API_VERSION = "v21.0";

// Cliente.telefono se carga a mano, sin formato fijo (con/sin "+593", con
// "0" inicial de Ecuador, con espacios/guiones) — la Cloud API exige E.164
// sin símbolos ("593987654321"). Asume Ecuador si no viene ya con otro
// código de país explícito (un "+" distinto de +593 se respeta tal cual).
export function normalizarTelefonoEcuador(telefono: string): string | null {
  const limpio = telefono.replace(/[^\d+]/g, "");
  if (limpio.startsWith("+")) return limpio.slice(1);
  if (limpio.startsWith("593")) return limpio;
  if (limpio.startsWith("0")) return `593${limpio.slice(1)}`;
  if (limpio.length === 9) return `593${limpio}`;
  return limpio.length >= 10 ? limpio : null;
}

export interface PlantillaWhatsapp {
  // Credenciales DE ESTA EMPRESA (ver EmpresaConfig.whatsapp* en
  // utils/empresas.ts) — nunca globales.
  accessToken: string;
  phoneNumberId: string;
  telefono: string;
  plantilla: string; // nombre EXACTO de la plantilla aprobada en el Meta Business Manager de ESTA empresa
  idioma?: string; // código de idioma con el que se aprobó la plantilla, ej. "es"
  parametros: string[]; // valores posicionales {{1}}, {{2}}... del body de la plantilla, en orden
}

// Devuelve true si Meta aceptó el envío, false si se omitió (teléfono
// inválido) o si Meta lo rechazó (plantilla no aprobada, número sin
// WhatsApp, etc. — el detalle queda en el log, nunca en una excepción que
// tumbe al llamador).
export async function enviarPlantillaWhatsapp(datos: PlantillaWhatsapp): Promise<boolean> {
  const numero = normalizarTelefonoEcuador(datos.telefono);
  if (!numero) {
    console.warn(`[whatsapp] Teléfono inválido, se omite el envío: "${datos.telefono}".`);
    return false;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${datos.phoneNumberId}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: numero,
        type: "template",
        template: {
          name: datos.plantilla,
          language: { code: datos.idioma || "es" },
          components: [
            {
              type: "body",
              parameters: datos.parametros.map((texto) => ({ type: "text", text: texto })),
            },
          ],
        },
      },
      { headers: { Authorization: `Bearer ${datos.accessToken}` } }
    );
    return true;
  } catch (error: any) {
    console.error(`[whatsapp] Meta rechazó el envío a ${numero}:`, error.response?.data || error.message);
    return false;
  }
}

// Texto libre (sin plantilla) — SOLO funciona dentro de la ventana de 24
// horas desde el último mensaje que ESE cliente nos mandó (regla de Meta, ver
// arriba). Lo usa la respuesta a un ticket de soporte que entró por WhatsApp
// (ver routes/tickets.ts), que ya valida esa ventana antes de llamar acá.
export async function enviarTextoWhatsapp(datos: { accessToken: string; phoneNumberId: string; telefono: string; texto: string }): Promise<boolean> {
  const numero = normalizarTelefonoEcuador(datos.telefono);
  if (!numero) return false;

  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${datos.phoneNumberId}/messages`,
      { messaging_product: "whatsapp", to: numero, type: "text", text: { body: datos.texto } },
      { headers: { Authorization: `Bearer ${datos.accessToken}` } }
    );
    return true;
  } catch (error: any) {
    console.error(`[whatsapp] Meta rechazó el texto a ${numero}:`, error.response?.data || error.message);
    return false;
  }
}
