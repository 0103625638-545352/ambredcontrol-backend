// Lectura por SNMP de las OLT Huawei (MA5608T, MA5800-X7) — solo lectura,
// nunca se escribe nada en el equipo (ver la decisión en schema.prisma:
// "Módulo de OLT"). Usa el MIB privado hwGpon de Huawei (rama empresa
// 1.3.6.1.4.1.2011.6.128), compartido por toda la familia SmartAX
// (MA5608T/MA5800/MA5680T...), más el estándar IF-MIB para nombres de
// puerto.
//
// *** IMPORTANTE — CALIBRACIÓN CONTRA EL EQUIPO REAL ***
// Los sub-OID exactos de las columnas de hwGponDeviceOntOpticalDdmInfoTable /
// hwGponDeviceOntBaseInfoTable pueden variar un poco según la versión de
// firmware de la OLT (Huawei no publica el MIB completo de forma abierta).
// Los valores de OIDS_HUAWEI_GPON de abajo son los que documentan de forma
// consistente varias herramientas de monitoreo de OLT Huawei de la
// comunidad (LibreNMS, Zabbix, scripts de NMS de ISPs), pero NO están
// verificados contra un MA5608T/MA5800-X7 real de esta empresa todavía.
// Antes de confiar en listarOnusDeOlt(), usar explorarOid() apuntando a
// OIDS_HUAWEI_GPON.baseOnt/baseDdm contra la OLT real y comparar la
// estructura devuelta — si las columnas no calzan, ajustar las constantes
// de acá (un solo lugar), no la lógica de parseo.
import { snmpGet, snmpWalk, type ConfigSnmp } from "./snmp";
import * as snmp from "net-snmp";

// OID estándar (MIB-2, RFC 1213) — estos SÍ son universales, cualquier
// equipo con SNMP los responde igual sin importar el fabricante.
const OID_SYS_DESCR = "1.3.6.1.2.1.1.1.0";
const OID_SYS_UPTIME = "1.3.6.1.2.1.1.3.0";
const OID_SYS_NAME = "1.3.6.1.2.1.1.5.0";
const OID_IF_DESCR_BASE = "1.3.6.1.2.1.2.2.1.2"; // + ".<ifIndex>"

// OID privados de Huawei — ver advertencia de calibración arriba.
export const OIDS_HUAWEI_GPON = {
  // hwGponDeviceOntOpticalDdmInfoTable: potencia óptica RX/TX de cada ONU.
  // Índice de fila: <ifIndex del puerto PON>.<onuId>
  ddmRxPower: "1.3.6.1.4.1.2011.6.128.1.1.2.51.1.4", // dBm * 100 (signed)
  ddmTxPower: "1.3.6.1.4.1.2011.6.128.1.1.2.51.1.6", // dBm * 100 (signed)

  // hwGponDeviceOntBaseInfoTable: identidad y descripción de cada ONU.
  // Mismo índice de fila que la tabla de arriba.
  ontSerial: "1.3.6.1.4.1.2011.6.128.1.1.2.43.1.4",
  ontDescripcion: "1.3.6.1.4.1.2011.6.128.1.1.2.43.1.9",

  // hwGponDeviceOntRunInfoTable: estado operativo (1 = online). Mismo índice.
  ontRunState: "1.3.6.1.4.1.2011.6.128.1.1.2.46.1.15",
};

function segundosDesdeTicks(ticks: number): number {
  return Math.floor(ticks / 100);
}

function valorComoTexto(valor: snmp.VarbindValue): string {
  if (Buffer.isBuffer(valor)) {
    // Serial de la ONU: si es texto imprimible (típico "HWTC..."), se usa
    // tal cual; si viene binario puro, se muestra en hex para no perder el
    // dato (mejor un hex feo que nada).
    const esImprimible = /^[\x20-\x7e]+$/.test(valor.toString("latin1"));
    return esImprimible ? valor.toString("ascii") : valor.toString("hex").toUpperCase();
  }
  return valor === null || valor === undefined ? "" : String(valor);
}

// Huawei reporta la potencia óptica unas veces como entero × 100 (ej. -350
// para -3.50 dBm) y otras ya como texto con el punto decimal puesto — se
// manejan los dos casos, priorizando el texto si trae un punto.
function parsearPotenciaDbm(valor: snmp.VarbindValue): number | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "number" || typeof valor === "bigint") {
    const n = Number(valor);
    if (n === 0x7fffffff || n === -1) return null; // "sin lectura" típico de Huawei
    return n / 100;
  }
  const texto = valorComoTexto(valor).trim();
  if (!texto) return null;
  const n = Number(texto);
  return Number.isFinite(n) ? n : null;
}

// Última parte de un OID devuelto por un walk relativo a "base" — ej. si
// base="1.3.6.1.4.1...51.1.4" y el varbind trae "...51.1.4.5001.3", el
// índice de fila es "5001.3" (ifIndex del puerto PON + id de ONU).
function indiceDeFila(oidCompleto: string, oidBase: string): string {
  return oidCompleto.startsWith(oidBase + ".") ? oidCompleto.slice(oidBase.length + 1) : "";
}

export interface EstadoBasicoOlt {
  sysDescr: string;
  sysName: string;
  uptimeSegundos: number;
}

// Prueba de conectividad genérica — usa SOLO OID estándar, así que sirve
// para confirmar credenciales/alcance de red contra CUALQUIER OLT (o
// cualquier equipo SNMP) antes de intentar interpretar sus tablas privadas.
export async function probarConexionSnmp(config: ConfigSnmp): Promise<EstadoBasicoOlt> {
  const varbinds = await snmpGet(config, [OID_SYS_DESCR, OID_SYS_NAME, OID_SYS_UPTIME]);
  return {
    sysDescr: valorComoTexto(varbinds[0]?.value),
    sysName: valorComoTexto(varbinds[1]?.value),
    uptimeSegundos: segundosDesdeTicks(Number(varbinds[2]?.value) || 0),
  };
}

export interface OidExplorado {
  oid: string;
  tipo: number | undefined;
  valor: string;
}

// Herramienta de calibración: recorre TODO lo que haya bajo un OID base y lo
// devuelve crudo — para comparar contra OIDS_HUAWEI_GPON de arriba usando el
// equipo real (ver POST /olts/:id/explorar-oid). No interpreta nada.
export async function explorarOid(config: ConfigSnmp, oidBase: string): Promise<OidExplorado[]> {
  const varbinds = await snmpWalk(config, oidBase);
  return varbinds.map((v) => ({ oid: v.oid, tipo: v.type, valor: valorComoTexto(v.value) }));
}

export interface OnuDetectada {
  slot: number;
  puerto: number;
  onuIndex: number;
  serial: string;
  descripcion: string | null;
  estado: "ONLINE" | "OFFLINE";
  rxPowerDbm: number | null;
  txPowerDbm: number | null;
}

// Extrae slot/puerto de la descripción estándar de interfaz que reporta la
// OLT (ej. "GPON 0/1/3" o "GPON0/1/3:1") — más confiable que decodificar a
// mano el ifIndex interno de Huawei (que empaqueta frame/slot/puerto en bits
// de forma no documentada públicamente y puede variar por modelo).
function extraerSlotPuerto(descripcionInterfaz: string): { slot: number; puerto: number } | null {
  const match = descripcionInterfaz.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return { slot: Number(match[2]), puerto: Number(match[3]) };
}

// Lee la tabla de ONUs de la OLT completa: potencia óptica, serial,
// descripción y estado de cada una, con su ubicación física (slot/puerto).
// Ver la advertencia de calibración al inicio del archivo — si esto vuelve
// una lista vacía en una OLT que sí tiene ONUs, lo primero es revisar con
// explorarOid() si las columnas de OIDS_HUAWEI_GPON siguen vigentes para el
// firmware de este equipo puntual.
export async function listarOnusDeOlt(config: ConfigSnmp): Promise<OnuDetectada[]> {
  const [rxVarbinds, txVarbinds, serialVarbinds, descVarbinds, estadoVarbinds, ifDescrVarbinds] = await Promise.all([
    snmpWalk(config, OIDS_HUAWEI_GPON.ddmRxPower),
    snmpWalk(config, OIDS_HUAWEI_GPON.ddmTxPower),
    snmpWalk(config, OIDS_HUAWEI_GPON.ontSerial),
    snmpWalk(config, OIDS_HUAWEI_GPON.ontDescripcion),
    snmpWalk(config, OIDS_HUAWEI_GPON.ontRunState),
    snmpWalk(config, OID_IF_DESCR_BASE),
  ]);

  // Mapa ifIndex -> "slot/puerto", a partir de la tabla estándar de
  // interfaces (ifDescr), para traducir el ifIndex de cada fila de ONU a una
  // ubicación física legible.
  const puertoPorIfIndex = new Map<string, { slot: number; puerto: number }>();
  for (const v of ifDescrVarbinds) {
    const ifIndex = indiceDeFila(v.oid, OID_IF_DESCR_BASE);
    const ubicacion = extraerSlotPuerto(valorComoTexto(v.value));
    if (ifIndex && ubicacion) puertoPorIfIndex.set(ifIndex, ubicacion);
  }

  // Se arma un registro por cada fila de la tabla de serial (es la que
  // identifica de forma más confiable qué filas son ONUs reales), y se le
  // cruzan los demás datos por el mismo índice de fila "<ifIndex>.<onuId>".
  const porIndice = new Map<string, Partial<OnuDetectada> & { ifIndex: string; onuId: number }>();

  for (const v of serialVarbinds) {
    const indice = indiceDeFila(v.oid, OIDS_HUAWEI_GPON.ontSerial);
    const partes = indice.split(".");
    if (partes.length < 2) continue;
    const onuId = Number(partes[partes.length - 1]);
    const ifIndex = partes.slice(0, -1).join(".");
    porIndice.set(indice, { ifIndex, onuId, serial: valorComoTexto(v.value) });
  }

  function registro(oid: string, indice: string): (Partial<OnuDetectada> & { ifIndex: string; onuId: number }) | undefined {
    return porIndice.get(indice);
  }

  for (const v of descVarbinds) {
    const indice = indiceDeFila(v.oid, OIDS_HUAWEI_GPON.ontDescripcion);
    const r = registro(v.oid, indice);
    if (r) r.descripcion = valorComoTexto(v.value) || null;
  }
  for (const v of estadoVarbinds) {
    const indice = indiceDeFila(v.oid, OIDS_HUAWEI_GPON.ontRunState);
    const r = registro(v.oid, indice);
    if (r) r.estado = Number(v.value) === 1 ? "ONLINE" : "OFFLINE";
  }
  for (const v of rxVarbinds) {
    const indice = indiceDeFila(v.oid, OIDS_HUAWEI_GPON.ddmRxPower);
    const r = registro(v.oid, indice);
    if (r) r.rxPowerDbm = parsearPotenciaDbm(v.value);
  }
  for (const v of txVarbinds) {
    const indice = indiceDeFila(v.oid, OIDS_HUAWEI_GPON.ddmTxPower);
    const r = registro(v.oid, indice);
    if (r) r.txPowerDbm = parsearPotenciaDbm(v.value);
  }

  const resultado: OnuDetectada[] = [];
  for (const r of porIndice.values()) {
    if (!r.serial) continue;
    const ubicacion = puertoPorIfIndex.get(r.ifIndex);
    resultado.push({
      slot: ubicacion?.slot ?? 0,
      puerto: ubicacion?.puerto ?? 0,
      onuIndex: r.onuId,
      serial: r.serial,
      descripcion: r.descripcion ?? null,
      estado: r.estado === "ONLINE" ? "ONLINE" : "OFFLINE",
      rxPowerDbm: r.rxPowerDbm ?? null,
      txPowerDbm: r.txPowerDbm ?? null,
    });
  }
  return resultado;
}
