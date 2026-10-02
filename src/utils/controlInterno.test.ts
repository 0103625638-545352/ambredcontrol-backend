import { describe, it, expect } from "vitest";
import { evaluarVisita, detectarAnomaliasCombustible, calcularSla, interpretarCalificacion } from "./controlInterno";
import { evaluarSenal, esCorteMasivo, puertoRecuperado } from "./monitoreoRed";
import { sugerirCategoria } from "./tickets";

const CLIENTE = { latitud: -2.9, longitud: -79.0 };
const LLEGADA = new Date("2026-10-01T10:00:00");
// ~0.001° de latitud ≈ 111 m
const cerca = { latitud: -2.9005, longitud: -79.0 };
const lejos = { latitud: -2.92, longitud: -79.0 }; // ~2.2 km

describe("evaluarVisita", () => {
  it("no es sospechosa si marcó cerca y no hay rastro GPS", () => {
    const r = evaluarVisita({ ...CLIENTE, distanciaAlPunto: 40, fechaLlegadaReal: LLEGADA }, []);
    expect(r.sospechosa).toBe(false);
  });

  it("es sospechosa si marcó Llegué lejos del cliente", () => {
    const r = evaluarVisita({ ...CLIENTE, distanciaAlPunto: 1500, fechaLlegadaReal: LLEGADA }, []);
    expect(r.sospechosa).toBe(true);
    expect(r.motivos[0]).toContain("1500 m");
  });

  it("acepta la visita si el rastro de fondo pasó cerca del cliente en la ventana", () => {
    const rastro = [{ ...cerca, fecha: new Date("2026-10-01T09:50:00") }];
    const r = evaluarVisita({ ...CLIENTE, distanciaAlPunto: 30, fechaLlegadaReal: LLEGADA }, rastro);
    expect(r.sospechosa).toBe(false);
    expect(r.distanciaRastroMetros).toBeLessThan(100);
  });

  it("es sospechosa si el rastro de fondo nunca se acercó", () => {
    const rastro = [{ ...lejos, fecha: new Date("2026-10-01T10:05:00") }];
    const r = evaluarVisita({ ...CLIENTE, distanciaAlPunto: 30, fechaLlegadaReal: LLEGADA }, rastro);
    expect(r.sospechosa).toBe(true);
  });

  it("es sospechosa si hay rastro ese día pero ninguno cerca de la hora de llegada", () => {
    const rastro = [{ ...cerca, fecha: new Date("2026-10-01T15:00:00") }];
    const r = evaluarVisita({ ...CLIENTE, distanciaAlPunto: 30, fechaLlegadaReal: LLEGADA }, rastro);
    expect(r.sospechosa).toBe(true);
  });
});

describe("detectarAnomaliasCombustible", () => {
  const base = (id: number, dia: number, km: number, galones: number) => ({
    id,
    vehiculoId: 1,
    fecha: new Date(2026, 8, dia),
    kilometraje: km,
    galones,
  });

  it("no marca nada con consumo parejo", () => {
    const cargas = [base(1, 1, 1000, 10), base(2, 5, 1300, 10), base(3, 9, 1600, 10), base(4, 13, 1900, 10)];
    expect(detectarAnomaliasCombustible(cargas)).toEqual([]);
  });

  it("marca una carga que rinde muy por debajo de la mediana del vehículo", () => {
    const cargas = [base(1, 1, 1000, 10), base(2, 5, 1300, 10), base(3, 9, 1600, 10), base(4, 13, 1700, 10), base(5, 17, 2000, 10)];
    const anomalias = detectarAnomaliasCombustible(cargas);
    expect(anomalias.map((a) => a.cargaId)).toEqual([4]);
  });

  it("marca un odómetro que no avanzó", () => {
    const cargas = [base(1, 1, 1000, 10), base(2, 5, 1000, 8)];
    const anomalias = detectarAnomaliasCombustible(cargas);
    expect(anomalias).toHaveLength(1);
    expect(anomalias[0].motivo).toContain("Odómetro");
  });

  it("no compara vehículos distintos entre sí", () => {
    const cargas = [
      base(1, 1, 1000, 10),
      base(2, 5, 1300, 10),
      { id: 3, vehiculoId: 2, fecha: new Date(2026, 8, 2), kilometraje: 500, galones: 10 },
      { id: 4, vehiculoId: 2, fecha: new Date(2026, 8, 6), kilometraje: 600, galones: 10 },
    ];
    expect(detectarAnomaliasCombustible(cargas)).toEqual([]);
  });
});

describe("calcularSla", () => {
  const creado = new Date("2026-10-01T08:00:00");

  it("un ticket ALTA abierto 5 horas está vencido", () => {
    const sla = calcularSla({ prioridad: "ALTA", createdAt: creado, fechaResolucion: null }, new Date("2026-10-01T13:00:00"));
    expect(sla.vencido).toBe(true);
    expect(sla.horasLimite).toBe(4);
  });

  it("un ticket resuelto mide hasta la resolución, no hasta ahora", () => {
    const sla = calcularSla(
      { prioridad: "ALTA", createdAt: creado, fechaResolucion: new Date("2026-10-01T10:00:00") },
      new Date("2026-10-05T00:00:00")
    );
    expect(sla.horasTranscurridas).toBe(2);
    expect(sla.vencido).toBe(false);
  });

  it("prioridad desconocida usa la de MEDIA", () => {
    const sla = calcularSla({ prioridad: "X", createdAt: creado, fechaResolucion: null }, creado);
    expect(sla.horasLimite).toBe(24);
  });
});

describe("interpretarCalificacion", () => {
  it.each([
    ["5", 5],
    [" 4 ", 4],
    ["3 regular", 3],
    ["4/5", 4],
    ["⭐⭐⭐⭐", 4],
  ])("'%s' → %s", (texto, esperado) => {
    expect(interpretarCalificacion(texto)).toBe(esperado);
  });

  it.each(["0", "6", "10", "no tengo internet", "1234 mi cédula", ""])("'%s' no es calificación", (texto) => {
    expect(interpretarCalificacion(texto)).toBeNull();
  });
});

describe("monitoreo de red", () => {
  it("señal bajo el umbral crítico es degradada aunque no haya historial", () => {
    expect(evaluarSenal(-28.5, null).degradada).toBe(true);
  });

  it("caída de 3 dB respecto a su promedio es degradada", () => {
    expect(evaluarSenal(-23.5, -20).degradada).toBe(true);
    expect(evaluarSenal(-21, -20).degradada).toBe(false);
  });

  it("corte masivo exige mínimo absoluto y la mitad del puerto", () => {
    expect(esCorteMasivo(2, 2)).toBe(false);
    expect(esCorteMasivo(3, 4)).toBe(true);
    expect(esCorteMasivo(3, 64)).toBe(false);
  });

  it("puerto recuperado con menos del 20% caído", () => {
    expect(puertoRecuperado(1, 10)).toBe(true);
    expect(puertoRecuperado(5, 10)).toBe(false);
  });
});

describe("sugerirCategoria (tickets por WhatsApp)", () => {
  it.each([
    ["Buenas, no tengo internet desde ayer", "SIN_SERVICIO", "ALTA"],
    ["el módem tiene la luz roja", "SIN_SERVICIO", "ALTA"],
    ["el internet está muy lento", "LENTITUD", "MEDIA"],
    ["se corta a cada rato", "INTERMITENCIA", "MEDIA"],
    ["ya hice la transferencia del pago", "FACTURACION", "BAJA"],
    ["no tengo plata para pagar este mes", "FACTURACION", "BAJA"],
    ["hola buenas tardes", "OTRO", "MEDIA"],
  ])("'%s' → %s/%s", (texto, categoria, prioridad) => {
    expect(sugerirCategoria(texto)).toEqual({ categoria, prioridad });
  });
});
