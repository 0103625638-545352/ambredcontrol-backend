import { describe, it, expect } from "vitest";
import { calcularDiasAtraso, bucketMora, calcularDiasParaVencer } from "./vencimientos";

const AHORA = new Date("2026-07-13T12:00:00");

function diasAntes(dias: number): Date {
  const fecha = new Date(AHORA);
  fecha.setDate(fecha.getDate() - dias);
  return fecha;
}

function diasDespues(dias: number): Date {
  return diasAntes(-dias);
}

describe("calcularDiasAtraso", () => {
  it("sin fecha de vencimiento: null", () => {
    expect(calcularDiasAtraso(null, "PENDIENTE", AHORA)).toBeNull();
  });

  it("vencimiento futuro: null", () => {
    expect(calcularDiasAtraso(diasDespues(5), "PENDIENTE", AHORA)).toBeNull();
  });

  it("vence hoy: todavía no cuenta como atrasada", () => {
    expect(calcularDiasAtraso(AHORA, "PENDIENTE", AHORA)).toBeNull();
  });

  it("venció ayer: 1 día de atraso", () => {
    expect(calcularDiasAtraso(diasAntes(1), "PENDIENTE", AHORA)).toBe(1);
  });

  it("venció hace 45 días: 45 días de atraso", () => {
    expect(calcularDiasAtraso(diasAntes(45), "PENDIENTE", AHORA)).toBe(45);
  });

  it("estadoPago PAGADA: siempre null aunque el vencimiento ya haya pasado", () => {
    expect(calcularDiasAtraso(diasAntes(90), "PAGADA", AHORA)).toBeNull();
  });

  it("PARCIAL vencida sí cuenta (solo PAGADA se excluye)", () => {
    expect(calcularDiasAtraso(diasAntes(10), "PARCIAL", AHORA)).toBe(10);
  });
});

describe("calcularDiasParaVencer", () => {
  it("sin fecha de vencimiento: null", () => {
    expect(calcularDiasParaVencer(null, AHORA)).toBeNull();
  });

  it("ya venció: null (eso lo cubre calcularDiasAtraso)", () => {
    expect(calcularDiasParaVencer(diasAntes(1), AHORA)).toBeNull();
  });

  it("vence hoy: 0", () => {
    expect(calcularDiasParaVencer(AHORA, AHORA)).toBe(0);
  });

  it("vence en 3 días: 3", () => {
    expect(calcularDiasParaVencer(diasDespues(3), AHORA)).toBe(3);
  });

  it("vence en 45 días: 45", () => {
    expect(calcularDiasParaVencer(diasDespues(45), AHORA)).toBe(45);
  });
});

describe("bucketMora", () => {
  it("null (al día)", () => {
    expect(bucketMora(null)).toBe("AL_DIA");
  });

  it("límites del bucket 1_30", () => {
    expect(bucketMora(1)).toBe("1_30");
    expect(bucketMora(30)).toBe("1_30");
  });

  it("límites del bucket 31_60", () => {
    expect(bucketMora(31)).toBe("31_60");
    expect(bucketMora(60)).toBe("31_60");
  });

  it("límites del bucket 61_90", () => {
    expect(bucketMora(61)).toBe("61_90");
    expect(bucketMora(90)).toBe("61_90");
  });

  it("más de 90: MAS_90", () => {
    expect(bucketMora(91)).toBe("MAS_90");
    expect(bucketMora(200)).toBe("MAS_90");
  });
});
