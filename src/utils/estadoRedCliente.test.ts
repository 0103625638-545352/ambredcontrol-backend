import { describe, it, expect } from "vitest";
import { calcularEstadoCliente, type EntradaEstadoCliente } from "./estadoRedCliente";

const BASE: EntradaEstadoCliente = {
  pingEstado: "OK",
  pingMs: 20,
  onuEstado: "ONLINE",
  onuRxPowerDbm: -15,
  onuSerial: "HWTC00000001",
  transicionesRecientes: 0,
  nodoNombre: "Nodo Centro",
  nodoMinutosSinConexion: 1,
};

describe("calcularEstadoCliente", () => {
  it("es OK cuando todas las señales están bien", () => {
    expect(calcularEstadoCliente(BASE).estado).toBe("OK");
  });

  it("es NODO_CAIDO cuando el Mikrotik del nodo lleva mucho sin responder, sin importar el resto", () => {
    expect(calcularEstadoCliente({ ...BASE, nodoMinutosSinConexion: 30 }).estado).toBe("NODO_CAIDO");
  });

  it("es ONU_OFFLINE cuando la ONU está offline", () => {
    expect(calcularEstadoCliente({ ...BASE, onuEstado: "OFFLINE" }).estado).toBe("ONU_OFFLINE");
  });

  it("es SIN_RESPUESTA cuando el ping falla y la ONU sigue online", () => {
    expect(calcularEstadoCliente({ ...BASE, pingEstado: "SIN_RESPUESTA", pingMs: null }).estado).toBe("SIN_RESPUESTA");
  });

  it("es INESTABLE cuando hubo varias transiciones recientes", () => {
    expect(calcularEstadoCliente({ ...BASE, transicionesRecientes: 4 }).estado).toBe("INESTABLE");
  });

  it("es LATENCIA_ALTA cuando el ping responde pero muy lento", () => {
    expect(calcularEstadoCliente({ ...BASE, pingMs: 300 }).estado).toBe("LATENCIA_ALTA");
  });

  it("es SENAL_DEBIL cuando la potencia óptica RX es muy baja", () => {
    expect(calcularEstadoCliente({ ...BASE, onuRxPowerDbm: -30 }).estado).toBe("SENAL_DEBIL");
  });

  it("es SIN_DATOS cuando no hay ni ONU ni ping", () => {
    expect(calcularEstadoCliente({ ...BASE, onuEstado: null, pingEstado: null, pingMs: null, onuRxPowerDbm: null }).estado).toBe("SIN_DATOS");
  });

  it("prioriza NODO_CAIDO sobre ONU_OFFLINE (el corte del nodo explica todo lo demás)", () => {
    expect(calcularEstadoCliente({ ...BASE, nodoMinutosSinConexion: 30, onuEstado: "OFFLINE" }).estado).toBe("NODO_CAIDO");
  });
});
