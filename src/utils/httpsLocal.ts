import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

// Detecta la IP LAN de esta PC y genera con mkcert, si hace falta, el
// certificado para esa IP dentro de certs-local-dev/ — así nadie tiene que
// editar nada a mano cuando la PC cambia de IP (WiFi <-> cable, DHCP, otra
// red). Se activa solo con HTTPS_LOCAL_AUTO="true" en .env (nunca en
// producción: ahí Nginx ya termina TLS y le habla a este proceso por HTTP
// interno, ver DESPLIEGUE.md). El mismo mecanismo está espejado en
// frontend/vite.config.ts — ambos detectan la IP por su cuenta y arman el
// mismo nombre de archivo (mkcert usa siempre "<ip>+3.pem"/"<ip>+3-key.pem"
// para 3 nombres extra además del principal), así terminan compartiendo el
// mismo certificado sin coordinarse entre sí.

const CARPETA_CERTS = path.resolve(__dirname, "..", "..", "..", "certs-local-dev");

function obtenerIpLan(): string | undefined {
  const interfaces = os.networkInterfaces();
  for (const [nombre, direcciones] of Object.entries(interfaces)) {
    if (!direcciones) continue;
    // Descarta adaptadores virtuales (Hyper-V, WSL, VPN, loopback) — solo
    // interesa la tarjeta real (Wi-Fi o Ethernet) por la que entra el celular.
    if (/vEthernet|Virtual|Loopback|Hyper-V|WSL/i.test(nombre)) continue;
    for (const dir of direcciones) {
      if (dir.family === "IPv4" && !dir.internal) return dir.address;
    }
  }
  return undefined;
}

export function resolverCertificadoHttpsLocal(): { rutaCertHttps?: string; rutaKeyHttps?: string } {
  // Override manual: si alguien setea HTTPS_CERT_PATH/HTTPS_KEY_PATH a mano
  // (ej. porque el auto-detect eligió la interfaz equivocada en una máquina
  // con varias tarjetas de red), esos archivos ganan siempre.
  const certManual = process.env.HTTPS_CERT_PATH;
  const keyManual = process.env.HTTPS_KEY_PATH;
  if (certManual && keyManual && fs.existsSync(certManual) && fs.existsSync(keyManual)) {
    return { rutaCertHttps: certManual, rutaKeyHttps: keyManual };
  }

  if (process.env.HTTPS_LOCAL_AUTO !== "true") return {};

  const ip = obtenerIpLan();
  if (!ip) return {};

  const rutaCert = path.join(CARPETA_CERTS, `${ip}+3.pem`);
  const rutaKey = path.join(CARPETA_CERTS, `${ip}+3-key.pem`);

  if (!fs.existsSync(rutaCert) || !fs.existsSync(rutaKey)) {
    try {
      execFileSync("mkcert", [ip, "localhost", "127.0.0.1", "::1"], { cwd: CARPETA_CERTS, stdio: "inherit" });
    } catch (err) {
      console.warn(
        `[https-local] No se pudo generar el certificado automáticamente para ${ip}. ¿mkcert está instalado y en el PATH? Sigue por HTTP plano. Detalle: ${err}`,
      );
      return {};
    }
  }

  if (fs.existsSync(rutaCert) && fs.existsSync(rutaKey)) {
    return { rutaCertHttps: rutaCert, rutaKeyHttps: rutaKey };
  }
  return {};
}
