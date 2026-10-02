// Lectura por SNMP de los switches TP-Link instalados en el domicilio de
// cada cliente (el equipo que reparte Wi-Fi/Ethernet dentro de la vivienda)
// — solo lectura, igual criterio que utils/oltHuawei.ts: nunca se configura
// nada del switch desde acá.
//
// A diferencia de la OLT (MIB privado de Huawei), acá se usa CASI TODO OID
// ESTÁNDAR (IF-MIB, RFC 1213/2863) — estado de puerto, velocidad y tráfico
// funcionan igual sin importar el modelo TP-Link puntual, porque son parte
// del estándar SNMP que cualquier switch gestionable respeta.
//
// *** EXCEPCIÓN — PoE SIN CALIBRAR ***
// La potencia PoE EXACTA en vatios NO es un dato estandarizado entre
// fabricantes por SNMP: cada marca la expone (si acaso) por un MIB privado
// propio, y no hay una fuente confiable/consistente documentada para
// TP-Link como sí la hay para el hwGpon de Huawei. Por eso acá solo se lee
// el ESTADO de entrega de PoE (pethPsePortDetectionStatus, RFC 3621 —
// "POWER-ETHERNET-MIB", este SÍ es un estándar IETF real) — alcanza para el
// caso de uso real (¿la antena/AP sigue recibiendo energía o no?), sin
// inventar un OID de vataje sin verificar. Si en el futuro hace falta el
// vataje real, calibrar con POST /switches/:id/explorar-oid contra un
// equipo real y agregar un lector aparte, sin tocar este.
import { snmpGet, snmpWalk, type ConfigSnmp } from "./snmp";
import * as snmp from "net-snmp";

const OID_SYS_DESCR = "1.3.6.1.2.1.1.1.0";
const OID_SYS_NAME = "1.3.6.1.2.1.1.5.0";

// IF-MIB (RFC 2863) — estándar, cualquier switch gestionable lo responde
// igual. ifXTable (ifHCInOctets/ifHCOutOctets/ifHighSpeed) es la extensión de
// 64 bits — se prefiere sobre ifInOctets/ifOutOctets/ifSpeed (32 bits) por el
// contador que se desborda cada ~34s a 1 Gbps full-duplex.
const OID_IF_DESCR = "1.3.6.1.2.1.2.2.1.2";
const OID_IF_OPER_STATUS = "1.3.6.1.2.1.2.2.1.8"; // 1=up, 2=down, otros=raro
const OID_IF_HC_IN_OCTETS = "1.3.6.1.2.1.31.1.1.1.6";
const OID_IF_HC_OUT_OCTETS = "1.3.6.1.2.1.31.1.1.1.10";
const OID_IF_HIGH_SPEED = "1.3.6.1.2.1.31.1.1.1.15"; // Mbps

// POWER-ETHERNET-MIB (RFC 3621) — estándar IETF para equipos PoE. Ver
// advertencia arriba: solo el ESTADO categórico, no vataje.
const OID_PETH_PSE_PORT_DETECTION_STATUS = "1.3.6.1.2.1.105.1.1.1.1.6";
const ESTADO_POE_POR_CODIGO: Record<number, string> = {
  1: "DISABLED",
  2: "SEARCHING",
  3: "DELIVERING_POWER",
  4: "FAULT",
  5: "OTHER_FAULT", // "test" en el RFC — se agrupa como fallo para no inventar una 6ta categoría rara
  6: "OTHER_FAULT",
};

function valorComoTexto(valor: snmp.VarbindValue): string {
  if (Buffer.isBuffer(valor)) {
    const esImprimible = /^[\x20-\x7e]+$/.test(valor.toString("latin1"));
    return esImprimible ? valor.toString("ascii") : valor.toString("hex").toUpperCase();
  }
  return valor === null || valor === undefined ? "" : String(valor);
}

function indiceDeFila(oidCompleto: string, oidBase: string): string {
  return oidCompleto.startsWith(oidBase + ".") ? oidCompleto.slice(oidBase.length + 1) : "";
}

export interface EstadoBasicoSwitch {
  sysDescr: string;
  sysName: string;
}

// Prueba de conectividad genérica — mismo criterio que probarConexionSnmp en
// oltHuawei.ts.
export async function probarConexionSwitch(config: ConfigSnmp): Promise<EstadoBasicoSwitch> {
  const varbinds = await snmpGet(config, [OID_SYS_DESCR, OID_SYS_NAME]);
  return { sysDescr: valorComoTexto(varbinds[0]?.value), sysName: valorComoTexto(varbinds[1]?.value) };
}

export interface OidExplorado {
  oid: string;
  tipo: number | undefined;
  valor: string;
}

// Herramienta de calibración — idéntica en espíritu a explorarOid en
// oltHuawei.ts: recorre TODO lo que haya bajo un OID base y lo devuelve
// crudo, sin interpretar nada. Pensada sobre todo para calibrar PoE (ver
// advertencia arriba) contra un equipo TP-Link real.
export async function explorarOidSwitch(config: ConfigSnmp, oidBase: string): Promise<OidExplorado[]> {
  const varbinds = await snmpWalk(config, oidBase);
  return varbinds.map((v) => ({ oid: v.oid, tipo: v.type, valor: valorComoTexto(v.value) }));
}

export interface PuertoDetectado {
  numeroPuerto: number;
  estado: "UP" | "DOWN";
  velocidadMbps: number | null;
  contadorEntradaBytes: bigint | null;
  contadorSalidaBytes: bigint | null;
  poeEstado: string | null;
}

// Lee el estado de TODOS los puertos del switch (hasta cantidadPuertos) por
// SNMP: estado up/down, velocidad negociada, contadores acumulados de
// tráfico (el CALLER calcula la tasa comparando contra la lectura anterior,
// ver sincronizarSwitch en routes/switches.ts) y estado de PoE si el equipo
// lo reporta. El ifIndex de un switch simple casi siempre coincide 1:1 con
// el número de puerto físico (1..N) — a diferencia de la OLT, TP-Link no
// mezcla frame/slot/puerto en el ifIndex, así que no hace falta traducir vía
// ifDescr salvo para confirmarlo (se usa igual, por las dudas de un modelo
// que arranque en un ifIndex distinto de 1 por tener, por ejemplo, una
// interfaz de gestión aparte).
export async function listarPuertosDeSwitch(config: ConfigSnmp, cantidadPuertos: number): Promise<PuertoDetectado[]> {
  const [descrVarbinds, estadoVarbinds, velocidadVarbinds, inVarbinds, outVarbinds, poeVarbinds] = await Promise.all([
    snmpWalk(config, OID_IF_DESCR),
    snmpWalk(config, OID_IF_OPER_STATUS),
    snmpWalk(config, OID_IF_HIGH_SPEED),
    snmpWalk(config, OID_IF_HC_IN_OCTETS),
    snmpWalk(config, OID_IF_HC_OUT_OCTETS),
    // PoE puede no existir en absoluto en un switch no-PoE, o el equipo
    // puede no soportar este MIB — un walk vacío/con error acá no debe
    // tirar abajo la lectura del resto (estado/tráfico sí importan siempre).
    snmpWalk(config, OID_PETH_PSE_PORT_DETECTION_STATUS).catch(() => [] as snmp.Varbind[]),
  ]);

  // Mapa ifIndex -> nombre de interfaz, para descartar interfaces virtuales
  // (VLAN, loopback) que algunos switches gestionables también exponen bajo
  // el mismo ifTable — nos quedamos solo con los primeros "cantidadPuertos"
  // ifIndex numéricamente más bajos que tengan descripción de puerto físico.
  const ifIndices = descrVarbinds
    .map((v) => Number(indiceDeFila(v.oid, OID_IF_DESCR)))
    .filter((i) => Number.isFinite(i))
    .sort((a, b) => a - b)
    .slice(0, cantidadPuertos);

  const estadoPorIndice = new Map(estadoVarbinds.map((v) => [indiceDeFila(v.oid, OID_IF_OPER_STATUS), Number(v.value)]));
  const velocidadPorIndice = new Map(velocidadVarbinds.map((v) => [indiceDeFila(v.oid, OID_IF_HIGH_SPEED), Number(v.value)]));
  const inPorIndice = new Map(inVarbinds.map((v) => [indiceDeFila(v.oid, OID_IF_HC_IN_OCTETS), v.value]));
  const outPorIndice = new Map(outVarbinds.map((v) => [indiceDeFila(v.oid, OID_IF_HC_OUT_OCTETS), v.value]));
  // La fila de PoE se indexa "<grupo>.<puerto>" (RFC 3621) — en un switch de
  // un solo módulo, <grupo> siempre es 1, así que el número de puerto es la
  // última parte del índice.
  const poePorIndicePuerto = new Map<number, number>();
  for (const v of poeVarbinds) {
    const indice = indiceDeFila(v.oid, OID_PETH_PSE_PORT_DETECTION_STATUS);
    const partes = indice.split(".");
    const puerto = Number(partes[partes.length - 1]);
    if (Number.isFinite(puerto)) poePorIndicePuerto.set(puerto, Number(v.value));
  }

  return ifIndices.map((ifIndex, posicion) => {
    const numeroPuerto = posicion + 1; // rotulado físico 1-based
    const estadoCodigo = estadoPorIndice.get(String(ifIndex));
    const estado: "UP" | "DOWN" = estadoCodigo === 1 ? "UP" : "DOWN";
    const codigoPoe = poePorIndicePuerto.get(numeroPuerto);
    return {
      numeroPuerto,
      estado,
      velocidadMbps: estado === "UP" ? Number(velocidadPorIndice.get(String(ifIndex))) || null : null,
      contadorEntradaBytes: inPorIndice.has(String(ifIndex)) ? BigInt(String(inPorIndice.get(String(ifIndex)))) : null,
      contadorSalidaBytes: outPorIndice.has(String(ifIndex)) ? BigInt(String(outPorIndice.get(String(ifIndex)))) : null,
      poeEstado: codigoPoe !== undefined ? ESTADO_POE_POR_CODIGO[codigoPoe] ?? null : null,
    };
  });
}
