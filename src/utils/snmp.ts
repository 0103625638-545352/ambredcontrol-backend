// Wrapper genérico sobre la librería "net-snmp" — no tiene nada específico
// de Huawei (eso vive en utils/oltHuawei.ts). Igual criterio que
// utils/mikrotik.ts con node-routeros: acá solo se resuelve "cómo hablar el
// protocolo", la lógica de negocio (qué OID significa qué) vive aparte.
//
// A diferencia de la conexión TCP del Mikrotik (que sí conviene cachear
// porque abrir sesión cuesta un login), SNMP es sobre UDP y no tiene sesión
// real que valga la pena mantener viva entre peticiones — cada función acá
// abre, hace lo suyo, y cierra.
import * as snmp from "net-snmp";

export interface ConfigSnmp {
  direccionIp: string;
  snmpPuerto: number;
  snmpVersion: string; // "1" | "2c" | "3"
  snmpComunidad?: string | null;
  snmpUsuario?: string | null;
  snmpAuthProtocolo?: string | null; // "MD5" | "SHA"
  snmpAuthPassword?: string | null;
  snmpPrivProtocolo?: string | null; // "DES" | "AES"
  snmpPrivPassword?: string | null;
}

const TIMEOUT_MS = 5000;
const RETRIES = 1;

function crearSesion(config: ConfigSnmp): snmp.Session {
  const opciones = { port: config.snmpPuerto, timeout: TIMEOUT_MS, retries: RETRIES, version: undefined as any };

  if (config.snmpVersion === "3") {
    if (!config.snmpUsuario) throw new Error("Falta snmpUsuario para SNMP v3");
    const tieneAuth = !!config.snmpAuthPassword;
    const tienePriv = !!config.snmpPrivPassword;
    const usuario: snmp.User = {
      name: config.snmpUsuario,
      level: tienePriv ? snmp.SecurityLevel.authPriv : tieneAuth ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv,
      authProtocol: config.snmpAuthProtocolo === "SHA" ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5,
      authKey: config.snmpAuthPassword || undefined,
      privProtocol: config.snmpPrivProtocolo === "AES" ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des,
      privKey: config.snmpPrivPassword || undefined,
    };
    return snmp.createV3Session(config.direccionIp, usuario, { ...opciones, version: 3 });
  }

  const version = config.snmpVersion === "1" ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(config.direccionIp, config.snmpComunidad || "public", { ...opciones, version });
}

// GET de uno o varios OID puntuales — para valores escalares (ej. sysDescr).
export function snmpGet(config: ConfigSnmp, oids: string[]): Promise<snmp.Varbind[]> {
  return new Promise((resolve, reject) => {
    const sesion = crearSesion(config);
    sesion.on("error", (error) => {
      sesion.close();
      reject(error);
    });
    sesion.get(oids, (error, varbinds) => {
      sesion.close();
      if (error) return reject(error);
      const conError = (varbinds || []).find((v) => snmp.isVarbindError(v));
      if (conError) return reject(new Error(snmp.varbindError(conError)));
      resolve(varbinds || []);
    });
  });
}

// Recorre TODA la subtree de un OID base — para tablas (ej. la tabla de ONUs)
// o para explorar qué hay bajo un OID cuando todavía no se sabe la
// estructura exacta (ver explorarOid en oltHuawei.ts).
export function snmpWalk(config: ConfigSnmp, oidBase: string): Promise<snmp.Varbind[]> {
  return new Promise((resolve, reject) => {
    const sesion = crearSesion(config);
    const resultado: snmp.Varbind[] = [];
    let sesionCerrada = false;
    sesion.on("error", (error) => {
      if (sesionCerrada) return;
      sesionCerrada = true;
      sesion.close();
      reject(error);
    });
    sesion.walk(
      oidBase,
      (varbinds) => {
        for (const v of varbinds) {
          if (!snmp.isVarbindError(v)) resultado.push(v);
        }
      },
      (error) => {
        if (sesionCerrada) return;
        sesionCerrada = true;
        sesion.close();
        if (error) return reject(error);
        resolve(resultado);
      }
    );
  });
}
