import { describe, it, expect } from "vitest";
import { calcularEstadoCaducidadCertificado } from "./alertasNegocio";

const AHORA = new Date("2026-07-11T12:00:00Z");

function diasDesdeAhora(dias: number): Date {
  return new Date(AHORA.getTime() + dias * 24 * 60 * 60 * 1000);
}

describe("calcularEstadoCaducidadCertificado", () => {
  it("no marca nada si el certificado está lejos de vencer", () => {
    const estado = calcularEstadoCaducidadCertificado(diasDesdeAhora(90), AHORA);
    expect(estado.vencido).toBe(false);
    expect(estado.porCaducar).toBe(false);
  });

  it("marca porCaducar dentro de la ventana de 30 días", () => {
    const estado = calcularEstadoCaducidadCertificado(diasDesdeAhora(15), AHORA);
    expect(estado.vencido).toBe(false);
    expect(estado.porCaducar).toBe(true);
    expect(estado.diasRestantes).toBe(15);
  });

  it("marca porCaducar justo en el borde de 30 días", () => {
    const estado = calcularEstadoCaducidadCertificado(diasDesdeAhora(30), AHORA);
    expect(estado.porCaducar).toBe(true);
  });

  it("no marca porCaducar apenas fuera de la ventana", () => {
    const estado = calcularEstadoCaducidadCertificado(diasDesdeAhora(31), AHORA);
    expect(estado.porCaducar).toBe(false);
  });

  it("marca vencido cuando la fecha de expiración ya pasó", () => {
    const estado = calcularEstadoCaducidadCertificado(diasDesdeAhora(-5), AHORA);
    expect(estado.vencido).toBe(true);
    expect(estado.porCaducar).toBe(false);
    expect(estado.diasRestantes).toBe(-5);
  });
});
