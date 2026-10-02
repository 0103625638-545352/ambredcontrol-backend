import { describe, it, expect } from "vitest";
import { rellenarPlantilla, limpiarParaPdf, generarContratoPdf, TEXTO_CONTRATO_POR_DEFECTO, type DatosContrato } from "./contratoServicio";

const datos: DatosContrato = {
  empresa: "H & A TECNOLOGIAS",
  rucEmpresa: "0302244108001",
  direccionEmpresa: "Cuenca",
  cliente: "PABLO BARRETO",
  cedula: "0104857180",
  direccion: "Misicata, Cuenca",
  telefono: "0987452523",
  plan: "Plan Hogar 5 Mbps",
  bajada: "5M",
  subida: "5M",
  precio: "15.00",
  diaCorte: "2",
  fechaInicio: "1 de octubre de 2026",
  vigenciaMeses: 12,
  ciudad: "Cuenca",
};

// PNG de 1x1 píxel, suficiente como "firma" para la prueba.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

describe("plantilla del contrato", () => {
  it("rellena todas las marcas de la plantilla por defecto", () => {
    const texto = rellenarPlantilla(TEXTO_CONTRATO_POR_DEFECTO, datos);
    expect(texto).not.toMatch(/\{\{/);
    expect(texto).toContain("PABLO BARRETO");
    expect(texto).toContain("USD 15.00");
    expect(texto).toContain("12 meses");
  });

  it("deja visible una marca desconocida para que se note el error", () => {
    expect(rellenarPlantilla("Hola {{cliente}} {{noExiste}}", datos)).toBe("Hola PABLO BARRETO {{noExiste}}");
  });

  it("sin vigencia pactada lo dice en el texto", () => {
    expect(rellenarPlantilla("{{textoVigencia}}", { ...datos, vigenciaMeses: null })).toContain("No tiene plazo mínimo");
  });

  it("limpia caracteres que no entran en las fuentes del PDF", () => {
    expect(limpiarParaPdf("“Hola” — señor 😀 ñandú")).toBe('"Hola" - señor  ñandú');
  });
});

describe("generarContratoPdf", () => {
  it("genera un PDF válido con equipos y firma", async () => {
    const bytes = await generarContratoPdf({
      datos,
      plantilla: rellenarPlantilla(TEXTO_CONTRATO_POR_DEFECTO, datos),
      equipos: [{ tipo: "ONU", modelo: "HG8145V5", serial: "HWTC1234" }],
      firmaPng: PNG,
      nombreFirmante: "PABLO BARRETO",
      cedulaFirmante: "0104857180",
      tecnico: "CAMILO ORTIZ",
      fechaFirma: new Date("2026-10-01T15:00:00"),
      ubicacion: { latitud: -2.9, longitud: -79.0 },
      logo: null,
    });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(2000);
  });
});
