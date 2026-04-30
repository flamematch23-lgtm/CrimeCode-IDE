#!/usr/bin/env bun
/**
 * provision-hetzner.ts — provisioning end-to-end in 60 secondi.
 *
 * Cosa fa:
 *   1. Genera una SSH keypair se non esiste (~/.ssh/crimeopus_ed25519)
 *   2. Carica la public key su Hetzner Cloud (idempotente)
 *   3. Crea il VPS (default CX22 €3.79/mese, Helsinki, Ubuntu 24.04)
 *   4. Attende che il server sia running + SSH raggiungibile
 *   5. (Opzionale) Crea record DNS Cloudflare A → IP del VPS
 *   6. SCP del codice del gateway al VPS
 *   7. SSH ed esegue deploy-vps.sh (Bun + systemd + Caddy + ufw)
 *   8. Stampa: IP, hostname, URL gateway, comandi utili
 *
 * Prerequisiti:
 *   - Account Hetzner Cloud + API token (scope: Read+Write)
 *     https://console.hetzner.cloud/projects/<id>/security/tokens
 *   - (Opzionale) Cloudflare API token per DNS automatico
 *     https://dash.cloudflare.com/profile/api-tokens
 *   - Comandi locali: ssh, scp, ssh-keygen
 *
 * Usage:
 *   HETZNER_TOKEN=xxx \
 *     bun scripts/provision-hetzner.ts \
 *       --name crimeopus-api \
 *       --domain api.tuodominio.dev \
 *       --type cx22 \
 *       --location hel1
 *
 *   # con DNS Cloudflare automatico:
 *   HETZNER_TOKEN=xxx CF_TOKEN=xxx CF_ZONE_ID=xxx \
 *     bun scripts/provision-hetzner.ts --domain api.tuodominio.dev
 *
 *   # dry-run senza creare nulla:
 *   bun scripts/provision-hetzner.ts --domain api.tuodominio.dev --dry-run
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const HCLOUD_BASE = "https://api.hetzner.cloud/v1"
const CF_BASE = "https://api.cloudflare.com/client/v4"

// ─── CLI ──────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (n: string, dflt = ""): string => {
  const eq = args.find((a) => a.startsWith(`--${n}=`))
  if (eq) return eq.slice(`--${n}=`.length)
  const i = args.indexOf(`--${n}`)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1]
  return dflt
}
const has = (n: string) => args.includes(`--${n}`)

if (has("help") || has("h")) {
  console.log(`bun scripts/provision-hetzner.ts [flags]

Required:
  --domain DOMAIN            es. api.tuodominio.dev (deve risolvere all'IP)

Server config (con default sensati):
  --name NAME                hostname VPS (default: crimeopus-api)
  --type TYPE                cx22 (€3.79) | cx32 (€6.45) | ccx13 (€12.49) | ccx23 (€24.49)
  --location LOC             hel1 (Helsinki) | nbg1 (Norimberga) | fsn1 (Falkenstein) | ash (US-East)
  --image IMG                ubuntu-24.04 (default)
  --ssh-key-name NAME        nome chiave Hetzner (default: crimeopus-deploy)

DNS automatico (opzionale, richiede CF_TOKEN + CF_ZONE_ID env):
  --skip-dns                 disabilita aggiornamento DNS Cloudflare
  --dns-ttl SEC              TTL record DNS (default 60s, "1" = automatic)

Code deploy:
  --skip-deploy              crea solo il VPS, non scp/ssh deploy
  --env-file PATH            .env locale da copiare sul VPS (default: ./.env)

Misc:
  --dry-run                  stampa cosa farebbe senza chiamare API
  --reuse-server             se un VPS con --name esiste già, lo riusa
                             invece di creare un duplicato

Env required:
  HETZNER_TOKEN              token Hetzner Cloud (Read+Write)
  CF_TOKEN, CF_ZONE_ID       Cloudflare (solo se DNS automatico)

Esempio completo:
  HETZNER_TOKEN=hcloud-xxx \\
    CF_TOKEN=cf-xxx CF_ZONE_ID=zone-xxx \\
    bun scripts/provision-hetzner.ts \\
      --name crimeopus-prod \\
      --domain api.crimeopus.dev \\
      --type cx22 --location hel1
`)
  process.exit(0)
}

const HETZNER_TOKEN = process.env.HETZNER_TOKEN
const CF_TOKEN = process.env.CF_TOKEN
const CF_ZONE_ID = process.env.CF_ZONE_ID
const DRY_RUN = has("dry-run")
const REUSE = has("reuse-server")

const NAME = flag("name", "crimeopus-api")
const TYPE = flag("type", "cx22")
const LOCATION = flag("location", "hel1")
const IMAGE = flag("image", "ubuntu-24.04")
const SSH_KEY_NAME = flag("ssh-key-name", "crimeopus-deploy")
const DOMAIN = flag("domain")
const ENV_FILE = flag("env-file", "./.env")
const SKIP_DNS = has("skip-dns")
const SKIP_DEPLOY = has("skip-deploy")
const DNS_TTL_RAW = flag("dns-ttl", "60")
const DNS_TTL = DNS_TTL_RAW === "1" ? 1 : Number(DNS_TTL_RAW)

if (!DOMAIN) bail("--domain è obbligatorio (es. api.tuodominio.dev)")
if (!HETZNER_TOKEN && !DRY_RUN) bail("HETZNER_TOKEN env var richiesta. Genera su https://console.hetzner.cloud → Security → API Tokens")

// ─── Utils ────────────────────────────────────────────────────────

const log = {
  step(n: number, msg: string) {
    console.log(`\n\x1b[1;36m[${n}]\x1b[0m \x1b[1m${msg}\x1b[0m`)
  },
  ok(msg: string) {
    console.log(`    \x1b[32m✓\x1b[0m ${msg}`)
  },
  warn(msg: string) {
    console.log(`    \x1b[33m⚠\x1b[0m ${msg}`)
  },
  err(msg: string) {
    console.log(`    \x1b[31m✗\x1b[0m ${msg}`)
  },
  info(msg: string) {
    console.log(`      ${msg}`)
  },
}

function bail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

async function hcloud<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (DRY_RUN) {
    console.log(`    [dry-run] ${method} ${path}${body ? " " + JSON.stringify(body) : ""}`)
    return {} as T
  }
  const r = await fetch(`${HCLOUD_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${HETZNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(`Hetzner API ${method} ${path} → HTTP ${r.status}: ${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

async function cloudflare<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (DRY_RUN) {
    console.log(`    [dry-run] CF ${method} ${path}${body ? " " + JSON.stringify(body) : ""}`)
    return {} as T
  }
  const r = await fetch(`${CF_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = (await r.json()) as { success: boolean; errors?: unknown[]; result?: T }
  if (!r.ok || !j.success) {
    throw new Error(`Cloudflare ${method} ${path} → ${JSON.stringify(j.errors).slice(0, 200)}`)
  }
  return j.result as T
}

function shell(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  if (DRY_RUN) {
    console.log(`    [dry-run] ${cmd} ${args.join(" ")}`)
    return ""
  }
  const r = spawnSync(cmd, args, { encoding: "utf8" })
  if (r.status !== 0 && !opts.allowFail) {
    bail(`comando fallito: ${cmd} ${args.join(" ")}\n${r.stderr || r.stdout}`)
  }
  return (r.stdout ?? "") + (r.stderr ?? "")
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Step 1 — SSH key ─────────────────────────────────────────────

log.step(1, "SSH keypair locale")

const sshDir = join(homedir(), ".ssh")
const sshKey = join(sshDir, "crimeopus_ed25519")
const sshPub = sshKey + ".pub"

if (!existsSync(sshDir)) {
  mkdirSync(sshDir, { recursive: true, mode: 0o700 })
}
if (!existsSync(sshKey)) {
  log.info(`generating ed25519 keypair → ${sshKey}`)
  shell("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "crimeopus-deploy", "-f", sshKey])
  if (!DRY_RUN) chmodSync(sshKey, 0o600)
  log.ok("keypair created")
} else {
  log.ok(`riusa keypair esistente: ${sshKey}`)
}

const pubKeyContent = DRY_RUN ? "ssh-ed25519 AAAA... fake" : readFileSync(sshPub, "utf8").trim()

// ─── Step 2 — Upload SSH key to Hetzner ───────────────────────────

log.step(2, `Carica SSH key su Hetzner (name="${SSH_KEY_NAME}")`)

interface HSSHKey {
  id: number
  name: string
  fingerprint: string
  public_key: string
}
let sshKeyId: number = 0
{
  const list = await hcloud<{ ssh_keys: HSSHKey[] }>("GET", "/ssh_keys")
  const existing = (list.ssh_keys ?? []).find((k) => k.name === SSH_KEY_NAME)
  if (existing) {
    sshKeyId = existing.id
    log.ok(`SSH key esistente riutilizzata: id=${existing.id} fingerprint=${existing.fingerprint.slice(0, 20)}…`)
  } else {
    const created = await hcloud<{ ssh_key: HSSHKey }>("POST", "/ssh_keys", {
      name: SSH_KEY_NAME,
      public_key: pubKeyContent,
    })
    sshKeyId = created.ssh_key?.id ?? 0
    log.ok(`SSH key creata: id=${sshKeyId}`)
  }
}

// ─── Step 3 — Create or reuse server ─────────────────────────────

log.step(3, `Provisiona VPS (type=${TYPE} location=${LOCATION} image=${IMAGE})`)

interface HServer {
  id: number
  name: string
  status: string
  public_net: { ipv4: { ip: string }; ipv6: { ip: string } }
  server_type: { name: string }
  datacenter: { location: { name: string } }
}

let server: HServer | null = null
{
  const list = await hcloud<{ servers: HServer[] }>("GET", `/servers?name=${encodeURIComponent(NAME)}`)
  const existing = (list.servers ?? []).find((s) => s.name === NAME)
  if (existing && REUSE) {
    server = existing
    log.ok(`riusa server esistente "${NAME}": id=${existing.id} ip=${existing.public_net?.ipv4?.ip}`)
  } else if (existing && !REUSE) {
    bail(
      `server "${NAME}" già esiste (id=${existing.id}). Aggiungi --reuse-server per riusarlo, ` +
        `o cambia --name, o eliminalo: hcloud server delete ${existing.id}`,
    )
  } else {
    const r = await hcloud<{ server: HServer; root_password?: string }>("POST", "/servers", {
      name: NAME,
      server_type: TYPE,
      location: LOCATION,
      image: IMAGE,
      ssh_keys: [sshKeyId],
      start_after_create: true,
      labels: { project: "crimeopus-api", managed_by: "provision-hetzner.ts" },
      user_data: `#cloud-config
package_update: true
package_upgrade: false
packages:
  - curl
  - rsync
  - ufw
  - git
runcmd:
  - ufw allow 22/tcp
  - ufw allow 80/tcp
  - ufw allow 443/tcp
  - ufw --force enable
`,
    })
    server = r.server
    log.ok(`server creato: id=${r.server.id}`)
  }
}

if (!server) bail("server non disponibile")

// ─── Step 4 — Wait for running + SSH ─────────────────────────────

log.step(4, "Attendi che il VPS sia running + SSH raggiungibile")

let ip = server.public_net?.ipv4?.ip ?? ""
if (!DRY_RUN) {
  for (let i = 0; i < 60; i++) {
    const r = await hcloud<{ server: HServer }>("GET", `/servers/${server.id}`)
    server = r.server
    ip = server.public_net?.ipv4?.ip ?? ip
    if (server.status === "running" && ip) break
    process.stdout.write(`    waiting… status=${server.status} ip=${ip || "?"}\r`)
    await sleep(2000)
  }
  console.log("")
  log.ok(`VPS running: ${NAME} @ ${ip}`)

  // Wait for SSH
  log.info("attesa SSH (max 90s)…")
  let sshReady = false
  for (let i = 0; i < 45; i++) {
    const r = spawnSync(
      "ssh",
      [
        "-i", sshKey,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=3",
        "-o", "BatchMode=yes",
        `root@${ip}`,
        "echo ready",
      ],
      { encoding: "utf8" },
    )
    if (r.status === 0 && r.stdout.includes("ready")) {
      sshReady = true
      break
    }
    process.stdout.write(`    SSH attempt ${i + 1}/45…\r`)
    await sleep(2000)
  }
  console.log("")
  if (!sshReady) bail("SSH non risponde entro 90s. Verifica VPS via console Hetzner.")
  log.ok("SSH ready")
}

// ─── Step 5 — DNS (Cloudflare) ────────────────────────────────────

if (SKIP_DNS) {
  log.step(5, "DNS — SKIP (--skip-dns)")
  log.warn(`Aggiorna manualmente: ${DOMAIN} A ${ip}`)
} else if (CF_TOKEN && CF_ZONE_ID) {
  log.step(5, `DNS Cloudflare: ${DOMAIN} A ${ip}`)
  interface CFRecord {
    id: string
    name: string
    type: string
    content: string
    ttl: number
  }
  const records = await cloudflare<CFRecord[]>(
    "GET",
    `/zones/${CF_ZONE_ID}/dns_records?name=${encodeURIComponent(DOMAIN)}&type=A`,
  )
  const existing = (records as unknown as CFRecord[])?.[0] ?? null
  if (existing) {
    if (existing.content === ip) {
      log.ok(`DNS già corretto (record id=${existing.id})`)
    } else {
      await cloudflare("PUT", `/zones/${CF_ZONE_ID}/dns_records/${existing.id}`, {
        type: "A",
        name: DOMAIN,
        content: ip,
        ttl: DNS_TTL,
        proxied: false, // Caddy gestisce TLS — proxy CF complica il cert
      })
      log.ok(`DNS aggiornato: ${existing.content} → ${ip}`)
    }
  } else {
    await cloudflare("POST", `/zones/${CF_ZONE_ID}/dns_records`, {
      type: "A",
      name: DOMAIN,
      content: ip,
      ttl: DNS_TTL,
      proxied: false,
    })
    log.ok(`DNS A record creato per ${DOMAIN}`)
  }
} else {
  log.step(5, "DNS — non configurato")
  log.warn(`CF_TOKEN/CF_ZONE_ID non set. Aggiorna manualmente:`)
  log.info(`   ${DOMAIN}  A  ${ip}  (TTL ${DNS_TTL}s)`)
  log.info(`   Senza DNS Caddy non potrà ottenere il certificato Let's Encrypt.`)
}

// ─── Step 6 — Deploy del codice ──────────────────────────────────

if (SKIP_DEPLOY) {
  log.step(6, "Deploy del codice — SKIP (--skip-deploy)")
} else {
  log.step(6, "rsync del pacchetto crimeopus-api → VPS")
  // Trova il path del pacchetto (siamo dentro packages/crimeopus-api/scripts)
  const pkgDir = join(import.meta.dir, "..")
  log.info(`source: ${pkgDir}`)
  if (!DRY_RUN) {
    shell(
      "rsync",
      [
        "-az",
        "--delete",
        "-e", `ssh -i ${sshKey} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`,
        "--exclude", "node_modules",
        "--exclude", "dist",
        "--exclude", "usage.db*",
        "--exclude", ".env",
        "--exclude", ".git*",
        "--exclude", "models-cache",
        `${pkgDir}/`,
        `root@${ip}:/tmp/crimeopus-api/`,
      ],
    )
  }
  log.ok("codice copiato")

  // Copia il .env localmente se esiste (contiene le tue chiavi cloud)
  if (existsSync(ENV_FILE)) {
    log.info(`upload .env locale (${ENV_FILE})…`)
    if (!DRY_RUN) {
      shell(
        "scp",
        [
          "-i", sshKey,
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          ENV_FILE,
          `root@${ip}:/tmp/crimeopus-api.env`,
        ],
      )
    }
    log.ok(".env caricato in /tmp/crimeopus-api.env")
  } else {
    log.warn(`${ENV_FILE} non trovato — il deploy script userà .env.example come template`)
  }

  // Esegui deploy-vps.sh
  log.step(7, "Esegui deploy-vps.sh sul VPS")
  if (!DRY_RUN) {
    const result = spawnSync(
      "ssh",
      [
        "-i", sshKey,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `root@${ip}`,
        `[ -f /tmp/crimeopus-api.env ] && cp /tmp/crimeopus-api.env /etc/crimeopus-api.env && chmod 600 /etc/crimeopus-api.env; ` +
          `bash /tmp/crimeopus-api/scripts/deploy-vps.sh ${DOMAIN}`,
      ],
      { stdio: "inherit" },
    )
    if (result.status !== 0) bail(`deploy-vps.sh exited ${result.status}`)
  }
  log.ok("deploy completato")
}

// ─── Riepilogo ────────────────────────────────────────────────────

console.log(`
\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
\x1b[1m  Provisioning completo\x1b[0m
\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m

  VPS:        ${NAME} (${TYPE} @ ${LOCATION})
  IP:         ${ip}
  Domain:     ${DOMAIN}
  SSH:        ssh -i ${sshKey} root@${ip}

  Endpoints:
    https://${DOMAIN}/healthz       (no auth)
    https://${DOMAIN}/v1/models     (Bearer auth)
    https://${DOMAIN}/admin         (basic auth via tunnel SSH consigliato)

  Logs:
    ssh -i ${sshKey} root@${ip} 'journalctl -u crimeopus-api -f'

  Restart:
    ssh -i ${sshKey} root@${ip} 'systemctl restart crimeopus-api'

  Edit .env:
    ssh -i ${sshKey} root@${ip} 'nano /etc/crimeopus-api.env'
    ssh -i ${sshKey} root@${ip} 'systemctl restart crimeopus-api'

  Tunnel SSH per /admin:
    ssh -i ${sshKey} -L 8787:127.0.0.1:8787 root@${ip}
    # poi apri http://localhost:8787/admin

  Costo mensile stimato: ${costEstimate(TYPE)}/mese (Hetzner CX22 = €3.79/mese)

  ⚠️  Aspetta 30-60 secondi che Caddy negozi il certificato Let's Encrypt
      la prima volta. Verifica con:
        curl https://${DOMAIN}/healthz
`)

function costEstimate(type: string): string {
  const map: Record<string, string> = {
    cx22: "€3.79",
    cx32: "€6.45",
    cx42: "€12.49",
    ccx13: "€12.49",
    ccx23: "€24.49",
  }
  return map[type] ?? "?"
}
