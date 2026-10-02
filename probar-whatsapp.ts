// Script de prueba manual para confirmar que utils/whatsapp.ts sabe hablarle
// a la API de Meta — SIN pasar por la lógica de negocio del job real (ver
// jobs/recordatorioVencimientoInternet.ts), que solo dispararía con un
// cliente real de la base de datos exactamente a N días de su corte y sin
// pagar. Genérico: sirve tanto para la plantilla de ejemplo de Meta como
// para la plantilla real ya aprobada.
//
// Uso: npx ts-node probar-whatsapp.ts <telefono> <accessToken> <phoneNumberId> <plantilla> <idioma> <param1> [param2] [...]
// Ejemplo (plantilla real): npx ts-node probar-whatsapp.ts +593999404696 EAAZA... 1383168738203522 recordatorio_vencimiento_de_pago es_EC "Juan Pérez" "Plan 800 Megas" 35.00 3 2026-09-25
import { enviarPlantillaWhatsapp } from "./src/utils/whatsapp";

async function main() {
  const [telefono, accessToken, phoneNumberId, plantilla, idioma, ...parametros] = process.argv.slice(2);
  if (!telefono || !accessToken || !phoneNumberId || !plantilla || !idioma || parametros.length === 0) {
    console.error(
      "Uso: npx ts-node probar-whatsapp.ts <telefono> <accessToken> <phoneNumberId> <plantilla> <idioma> <param1> [param2] [...]"
    );
    process.exit(1);
  }

  const enviado = await enviarPlantillaWhatsapp({ accessToken, phoneNumberId, telefono, plantilla, idioma, parametros });

  console.log(enviado ? "✅ Meta aceptó el envío — revisá tu WhatsApp." : "❌ No se pudo enviar (ver el detalle en el log de arriba).");
}

main();
