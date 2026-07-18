import { describe, it, expect } from "vitest";
import { emparejarMarcaciones, calcularHorasTrabajadas, type PuntoMarcacion } from "./horasTrabajadas";

// Todas las fechas se construyen en HORA LOCAL ("new Date(anio, mes, dia,
// hora, minuto)"), nunca con un string ISO — mismo criterio ya documentado
// en otros archivos de test de este proyecto (ver iess.test.ts).

describe("emparejarMarcaciones", () => {
  it("lista vacía: sin sesiones ni anomalías", () => {
    const { sesiones, anomalias } = emparejarMarcaciones([]);
    expect(sesiones).toHaveLength(0);
    expect(anomalias).toHaveLength(0);
  });

  it("emparejamiento simple: una entrada y una salida el mismo día", () => {
    const marcaciones: PuntoMarcacion[] = [
      { tipo: "ENTRADA", fecha: new Date(2026, 6, 21, 8, 0) },
      { tipo: "SALIDA", fecha: new Date(2026, 6, 21, 17, 0) },
    ];
    const { sesiones, anomalias } = emparejarMarcaciones(marcaciones);
    expect(anomalias).toHaveLength(0);
    expect(sesiones).toHaveLength(1);
    expect(sesiones[0].horas).toBe(9);
  });

  it("turno que cruza medianoche: resta el timestamp completo, no por día calendario", () => {
    const marcaciones: PuntoMarcacion[] = [
      { tipo: "ENTRADA", fecha: new Date(2026, 6, 21, 22, 0) },
      { tipo: "SALIDA", fecha: new Date(2026, 6, 22, 6, 0) },
    ];
    const { sesiones, anomalias } = emparejarMarcaciones(marcaciones);
    expect(anomalias).toHaveLength(0);
    expect(sesiones).toHaveLength(1);
    expect(sesiones[0].horas).toBe(8);
  });

  it("no ordena por asumir el orden de entrada — reordena por fecha aunque lleguen desordenadas", () => {
    const marcaciones: PuntoMarcacion[] = [
      { tipo: "SALIDA", fecha: new Date(2026, 6, 21, 17, 0) },
      { tipo: "ENTRADA", fecha: new Date(2026, 6, 21, 8, 0) },
    ];
    const { sesiones, anomalias } = emparejarMarcaciones(marcaciones);
    expect(anomalias).toHaveLength(0);
    expect(sesiones).toHaveLength(1);
    expect(sesiones[0].horas).toBe(9);
  });

  it("ENTRADA_SIN_SALIDA: queda una entrada abierta al final del rango", () => {
    const marcaciones: PuntoMarcacion[] = [{ tipo: "ENTRADA", fecha: new Date(2026, 6, 21, 8, 0) }];
    const { sesiones, anomalias } = emparejarMarcaciones(marcaciones);
    expect(sesiones).toHaveLength(0);
    expect(anomalias).toEqual([{ tipo: "ENTRADA_SIN_SALIDA", fecha: new Date(2026, 6, 21, 8, 0) }]);
  });

  it("SALIDA_SIN_ENTRADA: una salida sin ninguna entrada abierta", () => {
    const marcaciones: PuntoMarcacion[] = [{ tipo: "SALIDA", fecha: new Date(2026, 6, 21, 17, 0) }];
    const { sesiones, anomalias } = emparejarMarcaciones(marcaciones);
    expect(sesiones).toHaveLength(0);
    expect(anomalias).toEqual([{ tipo: "SALIDA_SIN_ENTRADA", fecha: new Date(2026, 6, 21, 17, 0) }]);
  });

  it("dos ENTRADA seguidas sin SALIDA entre medio: la primera se reporta como anomalía, la segunda sí empareja", () => {
    const marcaciones: PuntoMarcacion[] = [
      { tipo: "ENTRADA", fecha: new Date(2026, 6, 21, 8, 0) },
      { tipo: "ENTRADA", fecha: new Date(2026, 6, 21, 9, 0) },
      { tipo: "SALIDA", fecha: new Date(2026, 6, 21, 17, 0) },
    ];
    const { sesiones, anomalias } = emparejarMarcaciones(marcaciones);
    expect(anomalias).toEqual([{ tipo: "ENTRADA_SIN_SALIDA", fecha: new Date(2026, 6, 21, 8, 0) }]);
    expect(sesiones).toHaveLength(1);
    expect(sesiones[0].entrada).toEqual(new Date(2026, 6, 21, 9, 0));
    expect(sesiones[0].horas).toBe(8);
  });

  it("varios días válidos seguidos: cada uno empareja de forma independiente", () => {
    const marcaciones: PuntoMarcacion[] = [
      { tipo: "ENTRADA", fecha: new Date(2026, 6, 20, 8, 0) },
      { tipo: "SALIDA", fecha: new Date(2026, 6, 20, 16, 0) },
      { tipo: "ENTRADA", fecha: new Date(2026, 6, 21, 8, 0) },
      { tipo: "SALIDA", fecha: new Date(2026, 6, 21, 17, 30) },
    ];
    const { sesiones, anomalias } = emparejarMarcaciones(marcaciones);
    expect(anomalias).toHaveLength(0);
    expect(sesiones).toHaveLength(2);
    expect(sesiones[0].horas).toBe(8);
    expect(sesiones[1].horas).toBe(9.5);
  });
});

describe("calcularHorasTrabajadas", () => {
  it("suma las horas de todas las sesiones", () => {
    const { sesiones } = emparejarMarcaciones([
      { tipo: "ENTRADA", fecha: new Date(2026, 6, 20, 8, 0) },
      { tipo: "SALIDA", fecha: new Date(2026, 6, 20, 16, 0) },
      { tipo: "ENTRADA", fecha: new Date(2026, 6, 21, 8, 0) },
      { tipo: "SALIDA", fecha: new Date(2026, 6, 21, 17, 30) },
    ]);
    expect(calcularHorasTrabajadas(sesiones)).toBe(17.5);
  });

  it("0 sin sesiones", () => {
    expect(calcularHorasTrabajadas([])).toBe(0);
  });
});
