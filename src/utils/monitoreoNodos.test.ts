import { describe, it, expect } from "vitest";
import { debeAbrirAlerta, calcularDisponibilidad, formatearDuracion } from "./monitoreoNodos";

describe("monitoreo de nodos", () => {
  it("abre alerta con dos fallos seguidos si el nodo funcionaba antes", () => {
    expect(debeAbrirAlerta([{ enLinea: false }, { enLinea: false }], true)).toBe(true);
  });
  it("no alerta por un solo fallo", () => {
    expect(debeAbrirAlerta([{ enLinea: false }, { enLinea: true }], true)).toBe(false);
    expect(debeAbrirAlerta([{ enLinea: false }], true)).toBe(false);
  });
  it("no alerta un nodo que nunca estuvo en línea", () => {
    expect(debeAbrirAlerta([{ enLinea: false }, { enLinea: false }], false)).toBe(false);
  });
  it("calcula la disponibilidad con un decimal", () => {
    expect(calcularDisponibilidad(287, 288)).toBe(99.7);
    expect(calcularDisponibilidad(0, 0)).toBeNull();
  });
  it("formatea duraciones", () => {
    expect(formatearDuracion(12)).toBe("12 min");
    expect(formatearDuracion(135)).toBe("2 h 15 min");
    expect(formatearDuracion(60 * 50)).toBe("2 días 2 h");
  });
});
