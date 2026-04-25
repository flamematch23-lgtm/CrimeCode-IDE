import { createResource, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"

type Node = {
  name: string
  path: string
  type: "file" | "directory"
  size?: number
  mtime?: number
  children?: Node[]
}

type Engagement = {
  project: string
  worktree: string
  root: string
  tree: Node[]
}

type Category =
  | "all"
  | "recon"
  | "scanning"
  | "exploitation"
  | "phishing"
  | "reporting"
  | "reversing"
  | "osint"
  | "netrecon"
  | "vulnresearch"
  | "se"

type Tool = {
  id: string
  name: string
  desc: string
  cat: Exclude<Category, "all">
  prompt: string
}

const TOOLS: Tool[] = [
  {
    id: "whois",
    name: "WHOIS Lookup",
    desc: "Informazioni di registrazione del dominio",
    cat: "recon",
    prompt: "Usa lo strumento whois per cercare i dettagli di registrazione di example.com",
  },
  {
    id: "dns",
    name: "DNS Recon",
    desc: "Record, sottodomini, propagazione",
    cat: "recon",
    prompt: "Usa lo strumento dns_lookup per enumerare sottodomini e raccogliere record A/MX/TXT/NS di example.com",
  },
  {
    id: "url",
    name: "Analizzatore URL",
    desc: "Decomponi e segnala URL sospetti",
    cat: "recon",
    prompt:
      "Usa lo strumento url_analyzer per ispezionare https://example.com/path?id=1 alla ricerca di rischi di sicurezza",
  },
  {
    id: "ports",
    name: "Scansione Porte",
    desc: "Porte aperte e servizi",
    cat: "scanning",
    prompt: "Usa lo strumento port_scanner contro scanme.nmap.org con ports='common'",
  },
  {
    id: "nmap",
    name: "Wrapper Nmap",
    desc: "Scansione nmap completa con -sV/-sC",
    cat: "scanning",
    prompt: "Usa lo strumento nmap per eseguire una scansione di service-version su scanme.nmap.org",
  },
  {
    id: "nuclei",
    name: "Nuclei",
    desc: "Scansione CVE basata su template",
    cat: "scanning",
    prompt: "Usa lo strumento nuclei per scansionare https://example.com con severity=high,critical",
  },
  {
    id: "ssl",
    name: "Ispettore SSL",
    desc: "Catena di certificati e scadenza",
    cat: "scanning",
    prompt: "Usa lo strumento ssl_checker per ispezionare example.com:443",
  },
  {
    id: "headers",
    name: "Header di Sicurezza",
    desc: "CSP, HSTS, X-Frame-Options",
    cat: "scanning",
    prompt: "Usa lo strumento security_headers per controllare https://example.com",
  },
  {
    id: "vuln",
    name: "Scanner Vulnerabilità",
    desc: "Sonde XSS/SQLi/CSRF/IDOR/SSRF",
    cat: "exploitation",
    prompt: "Usa lo strumento vuln_scanner contro https://target.example.com verificando xss, sqli, ssrf",
  },
  {
    id: "sqlmap",
    name: "Sqlmap",
    desc: "Automazione SQL injection",
    cat: "exploitation",
    prompt: "Usa lo strumento sqlmap contro https://target.example.com/page?id=1 con --batch --risk=2",
  },
  {
    id: "jwt",
    name: "Strumento JWT",
    desc: "Decodifica/forgia/attacchi none-alg",
    cat: "exploitation",
    prompt: "Usa jwt_tool per decodificare e tentare forgery con algoritmo none su questo token: <INCOLLA_JWT>",
  },
  {
    id: "ssrf",
    name: "Sonda SSRF",
    desc: "Metadati cloud e sonde interne",
    cat: "exploitation",
    prompt: "Usa lo strumento ssrf_probe contro il parametro 'url' su https://target.example.com/fetch?url=",
  },
  {
    id: "cve",
    name: "Esecutore PoC CVE",
    desc: "Sfruttamento di CVE selezionate",
    cat: "exploitation",
    prompt: "Usa lo strumento cve_poc per testare CVE-2021-44228 (Log4Shell) contro https://target.example.com",
  },
  {
    id: "wordlist",
    name: "Wordlist",
    desc: "Genera e cracka hash",
    cat: "exploitation",
    prompt: "Usa lo strumento wordlist per generare una wordlist a-z di 5 caratteri con 1000 voci",
  },
  {
    id: "phish",
    name: "Generatore Phishing",
    desc: "8 template: email, vishing, SMS, USB",
    cat: "phishing",
    prompt: "Usa lo strumento phishing con template=credential_harvest brand=Acme target=staff@acme.com",
  },
  {
    id: "report",
    name: "Report Pentest",
    desc: "Report markdown con punteggio CVSS",
    cat: "reporting",
    prompt: "Usa lo strumento pentest_report per compilare i risultati di questo engagement in un report cliente",
  },
  // Reverse Engineering
  {
    id: "strings",
    name: "Estrai Stringhe",
    desc: "Stringhe printable da binario (strings-style)",
    cat: "reversing",
    prompt:
      "Analizza il binario <percorso> ed estrai tutte le stringhe stampabili di lunghezza >= 4; evidenzia URL, chiavi API, path sospetti",
  },
  {
    id: "pe-headers",
    name: "Header PE",
    desc: "Sezioni, import, export di un eseguibile PE",
    cat: "reversing",
    prompt:
      "Analizza gli header PE di <binario>: sezioni (.text, .data, .rsrc), tabella import DLL, export, timestamp e checksum",
  },
  {
    id: "disasm",
    name: "Disassembler AI",
    desc: "Analisi assembly assistita dall'AI",
    cat: "reversing",
    prompt:
      "Disassembla la funzione a offset <0xADDR> nel binario <file> e spiega in italiano cosa fa, con pseudocodice C equivalente",
  },
  {
    id: "entropy",
    name: "File Entropy",
    desc: "Rileva packing/cifratura via entropia",
    cat: "reversing",
    prompt:
      "Calcola l'entropia di Shannon sezione per sezione di <binario>; segnala sezioni con entropia > 7.0 come probabilmente packed/cifrate",
  },
  {
    id: "yara",
    name: "YARA Match",
    desc: "Pattern matching con regole YARA",
    cat: "reversing",
    prompt: "Scrivi e applica regole YARA per rilevare le seguenti caratteristiche nel campione <file>: <descrizione>",
  },
  {
    id: "deobfuscate",
    name: "Deobfuscation",
    desc: "Deobfusca JS / PS1 / VBA / batch",
    cat: "reversing",
    prompt:
      "Deobfusca il seguente codice <linguaggio> e spiega passo per passo cosa fa ogni blocco:\n\n<INCOLLA_CODICE>",
  },
  // OSINT
  {
    id: "shodan",
    name: "Shodan Recon",
    desc: "Ricerca Shodan per IP/dominio/banner",
    cat: "osint",
    prompt:
      "Costruisci una query Shodan per trovare server <tecnologia> esposti appartenenti a <org>; mostra i filtri net:, org:, port:, product:, vuln: da usare",
  },
  {
    id: "crtsh",
    name: "Certificate Transparency",
    desc: "Sottodomini via crt.sh",
    cat: "osint",
    prompt:
      "Usa lo strumento dns_lookup action=subdomains su <dominio> per enumerare sottodomini via certificate transparency, poi verifica quali rispondono",
  },
  {
    id: "github-recon",
    name: "GitHub Recon",
    desc: "GitHub dork per secret/API key leaked",
    cat: "osint",
    prompt:
      "Genera dork GitHub per trovare chiavi API, password e secret leaked per l'organizzazione <org>: usa operatori repo:, org:, filename:, extension:, in:file",
  },
  {
    id: "google-dorks",
    name: "Google Dork",
    desc: "Generatore Google dork personalizzato",
    cat: "osint",
    prompt:
      "Genera 10 Google dork per <target> mirati a: login page esposte, file di configurazione, directory listing, VPN/pannelli admin, documenti interni",
  },
  {
    id: "email-enum",
    name: "Email Enumeration",
    desc: "Enumerazione email (Hunter.io style)",
    cat: "osint",
    prompt:
      "Genera pattern email probabili per <azienda> (es. nome.cognome@, n.cognome@, ecc.) e suggerisci come verificarli con SMTP VRFY o servizi OSINT pubblici",
  },
  {
    id: "breach-check",
    name: "Breach Check",
    desc: "Verifica breach (HIBP-style)",
    cat: "osint",
    prompt:
      "Elenca tutte le procedure per verificare se l'email <email> o il dominio <dominio> è presente in breach database pubblici (HIBP, DeHashed, LeakCheck) senza violare ToS",
  },
  {
    id: "linkedin-osint",
    name: "LinkedIn OSINT",
    desc: "Profilo dipendenti e struttura aziendale",
    cat: "osint",
    prompt:
      "Costruisci una guida OSINT per mappare la struttura di <azienda> tramite LinkedIn: dork Google site:linkedin.com/in, Sales Navigator filters, estrazione organigramma per spear-phishing",
  },
  // Network Recon
  {
    id: "traceroute",
    name: "Traceroute Analysis",
    desc: "Network path e hop analysis",
    cat: "netrecon",
    prompt:
      "Interpreta questo output traceroute verso <host> e identifica: provider intermedi, salti con latenza anomala, possibili firewall/proxy trasparenti:\n\n<INCOLLA_OUTPUT>",
  },
  {
    id: "banner-grab",
    name: "Banner Grabbing",
    desc: "Banner grabbing su servizi esposti",
    cat: "netrecon",
    prompt:
      "Usa lo strumento nmap con flags='-sV --script=banner -p <porte>' su <host> per catturare banner di servizio e identifica versioni vulnerabili",
  },
  {
    id: "arp-scan",
    name: "ARP Scan LAN",
    desc: "Scoperta host rete locale",
    cat: "netrecon",
    prompt:
      "Genera il comando arp-scan / nmap -sn per scoprire tutti gli host attivi nella subnet <CIDR>, poi suggerisci come fingerprinting OS con -O",
  },
  {
    id: "passive-recon",
    name: "Recon Passivo",
    desc: "Shodan/Censys/Fofa senza toccare il target",
    cat: "netrecon",
    prompt:
      "Conduci recon passivo su <target> usando solo fonti pubbliche (Shodan, Censys, Fofa, Robtex, VirusTotal): servizi esposti, ASN, certificati, history DNS",
  },
  {
    id: "asn-lookup",
    name: "ASN / CIDR Lookup",
    desc: "Autonomous System Number e IP range",
    cat: "netrecon",
    prompt:
      "Trova l'ASN di <org>/<IP> e i relativi CIDR announciati; usa bgp.he.net e whois ARIN/RIPE per mappare l'intera superficie IP dell'organizzazione",
  },
  // Vulnerability Research
  {
    id: "cve-search",
    name: "CVE Search",
    desc: "Ricerca NVD/CVE database",
    cat: "vulnresearch",
    prompt:
      "Usa lo strumento cve_poc per cercare vulnerabilità relative a '<tecnologia> <versione>'; riassumi CVSS, vettore di attacco e disponibilità di exploit",
  },
  {
    id: "patch-diff",
    name: "Patch Diff Analysis",
    desc: "Analisi diff patch per vulnerabilità",
    cat: "vulnresearch",
    prompt:
      "Analizza questo diff di patch e identifica la radice della vulnerabilità corretta, il tipo CWE, e come replicare il bug sulla versione non patchata:\n\n<INCOLLA_DIFF>",
  },
  {
    id: "code-audit",
    name: "Code Audit",
    desc: "Audit sicurezza sorgente",
    cat: "vulnresearch",
    prompt:
      "Esegui un audit di sicurezza completo del seguente codice <linguaggio>: cerca injection, deserializzazione insicura, SSRF, path traversal, race condition, secrets hardcoded:\n\n<INCOLLA_CODICE>",
  },
  {
    id: "dep-audit",
    name: "Dependency Audit",
    desc: "Vulnerabilità dipendenze npm/pip/cargo",
    cat: "vulnresearch",
    prompt:
      "Analizza il file <package.json/requirements.txt/Cargo.toml> e identifica dipendenze con CVE note; suggerisci versioni patched e breaking changes da considerare",
  },
  {
    id: "ghsa-search",
    name: "GHSA Search",
    desc: "GitHub Security Advisory search",
    cat: "vulnresearch",
    prompt:
      "Cerca nel GitHub Security Advisory Database advisory relativi a '<ecosistema> <pacchetto>'; elenca GHSA ID, severity, versioni affette e fix disponibili",
  },
  {
    id: "exploit-search",
    name: "Exploit Search",
    desc: "Ricerca exploit (exploit-db/packetstorm)",
    cat: "vulnresearch",
    prompt:
      "Cerca exploit pubblici per <CVE o tecnologia>: usa Exploit-DB searchsploit syntax, PacketStorm, GitHub; valuta affidabilità e se è richiesto auth/interaction",
  },
  // Social Engineering
  {
    id: "pretexting",
    name: "Scenario Pretexting",
    desc: "Generatore scenario pretexting",
    cat: "se",
    prompt:
      "Genera uno scenario di pretexting dettagliato per un engagement contro <azienda>: ruolo assunto, motivo della chiamata/email, documenti/info necessari, possibili obiezioni e risposte",
  },
  {
    id: "vishing",
    name: "Script Vishing",
    desc: "Script vishing con gestione obiezioni",
    cat: "se",
    prompt:
      "Usa lo strumento phishing template=vishing_script brand=<azienda> per generare uno script vishing completo con: apertura, raccolta info, gestione obiezioni, chiusura",
  },
  {
    id: "baiting",
    name: "Baiting Fisico",
    desc: "USB drop, QR code, scenario fisico",
    cat: "se",
    prompt:
      "Usa lo strumento phishing template=usb_drop brand=<azienda> per generare kit USB drop completo; aggiungi anche scenario con QR code su poster in area comune",
  },
  {
    id: "impersonation",
    name: "Impersonation Script",
    desc: "IT helpdesk, vendor, audit esterno",
    cat: "se",
    prompt:
      "Genera script di impersonation per <ruolo: IT helpdesk / vendor / auditor esterno> in un engagement contro <azienda>: dialogo, pretesto, dati da raccogliere, come terminare la call",
  },
  {
    id: "osint-target",
    name: "Profilo Target SE",
    desc: "Costruisci profilo OSINT per SE",
    cat: "se",
    prompt:
      "Costruisci un profilo completo da OSINT per personalizzare un attacco SE contro <nome dipendente> di <azienda>: LinkedIn, pubblicazioni, interessi, colleghi, tecnologie usate, pattern email",
  },
  {
    id: "spearphish",
    name: "Spear-Phishing Email",
    desc: "Email spear-phishing personalizzata",
    cat: "se",
    prompt:
      "Usa lo strumento phishing template=credential_harvest brand=<azienda> e personalizza l'email per <nome target> usando questi dettagli OSINT: <dettagli>; includi pretext convincente",
  },
  {
    id: "awareness",
    name: "Training Anti-SE",
    desc: "Materiale awareness aziendale",
    cat: "se",
    prompt:
      "Genera un modulo di awareness training anti-social-engineering per dipendenti di <azienda>: riconoscere phishing, vishing, baiting; quiz a scelta multipla; policy da seguire",
  },
]

const SE_TEMPLATES = [
  { id: "pretexting", name: "Pretexting", desc: "Scenario completo con ruolo, motivo, obiezioni" },
  { id: "vishing_script", name: "Script Vishing", desc: "Call script con apertura/chiusura e gestione obiezioni" },
  { id: "usb_drop", name: "USB Drop Kit", desc: "File esca, autorun, README, guida deployment" },
  { id: "impersonation", name: "Impersonation", desc: "IT helpdesk / vendor / auditor esterno" },
  { id: "spearphish_custom", name: "Spear-Phishing", desc: "Email personalizzata con dati OSINT target" },
  { id: "awareness", name: "Training Anti-SE", desc: "Modulo awareness con quiz per dipendenti" },
]

const PHISHING_TEMPLATES = [
  { id: "credential_harvest", name: "Raccolta Credenziali", desc: "Email + landing page che cattura credenziali" },
  { id: "ms365_login", name: "Login MS365", desc: "Clone del sign-in di Office 365" },
  { id: "google_workspace", name: "Google Workspace", desc: "Clone del login Google" },
  { id: "invoice_lure", name: "Esca Fattura", desc: "Fattura PDF con link malevolo" },
  { id: "package_delivery", name: "Consegna Pacco", desc: "Pretesto di notifica spedizione" },
  { id: "vishing_script", name: "Script Vishing", desc: "Script per chiamate phishing vocali + gestione obiezioni" },
  { id: "sms_lure", name: "SMS / Smishing", desc: "5 corpi SMS + landing page mobile" },
  { id: "usb_drop", name: "USB Drop", desc: "Nomi file esca, README, autorun, guida al deployment" },
]

const QUICK_ENGAGEMENTS = [
  {
    name: "Pentest Esterno Completo",
    prompt:
      "Esegui un workflow completo di pentest esterno su https://target.example.com: recon (whois, dns, sottodomini), scansione (nmap, nuclei, security_headers, ssl_checker), exploitation (vuln_scanner, sqlmap, jwt_tool se applicabile), poi compila un pentest_report.",
  },
  {
    name: "Valutazione Web App",
    prompt:
      "Esegui una valutazione web app secondo OWASP WSTG su https://target.example.com. Usa vuln_scanner per XSS/SQLi/CSRF/IDOR/SSRF, ssrf_probe su qualsiasi parametro che accetta URL, jwt_tool su qualsiasi token, e produci un pentest_report.",
  },
  {
    name: "Campagna Phishing",
    prompt:
      "Pianifica e genera una campagna phishing multi-canale per l'engagement contro acme.com: email credential_harvest, sms_lure per i dirigenti, vishing_script per pretesto help-desk, e un kit usb_drop per drop fisici. Salva tutti gli artefatti in pentest-output/phishing-acme/.",
  },
  {
    name: "Recon Red Team",
    prompt:
      "Conduci recon passivo + attivo su acme.com: whois, enumerazione sottodomini DNS, port_scanner sugli host scoperti, nmap -sV -sC sui risultati principali, poi riassumi la superficie d'attacco.",
  },
  {
    name: "Caccia alle CVE",
    prompt:
      "Usa nuclei contro https://target.example.com filtrato per severity=high,critical, poi per ogni risultato suggerisci un'invocazione cve_poc per validare la sfruttabilità.",
  },
  {
    name: "Reverse Engineering Malware",
    prompt:
      "Analizza il campione <percorso>: estrai stringhe, calcola entropia sezioni, disassembla entry point e funzioni sospette, scrivi regole YARA per rilevarlo, deobfusca eventuali strati. Salva artefatti in pentest-output/re-<campione>/.",
  },
  {
    name: "OSINT Full Target",
    prompt:
      "Conduci OSINT completo su <azienda>: WHOIS, DNS recon, certificate transparency (sottodomini), Shodan dork, Google dork per file esposti, LinkedIn per dipendenti chiave, GitHub dork per secret leaked. Compila tutto in un profilo target.",
  },
  {
    name: "Campagna Social Engineering",
    prompt:
      "Pianifica una campagna SE completa contro <azienda>: 1) profilo OSINT dipendenti chiave, 2) script vishing per pretesto IT helpdesk, 3) email spear-phishing personalizzata per C-level, 4) scenario USB drop per reception, 5) materiale awareness per debriefing post-test. Salva in pentest-output/se-<azienda>/.",
  },
]

type TreeProps = {
  nodes: Node[]
  depth: number
  open: Set<string>
  toggle: (p: string) => void
  onFile: (p: string) => void
  fmtSize: (n?: number) => string
}

function Tree(props: TreeProps) {
  return (
    <ul class="space-y-0.5">
      <For each={props.nodes}>
        {(n) => (
          <li>
            <Show
              when={n.type === "directory"}
              fallback={
                <button
                  onClick={() => props.onFile(n.path)}
                  class="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-raised-base-hover text-left"
                  style={{ "padding-left": `${props.depth * 12 + 8}px` }}
                >
                  <Icon name="code-lines" class="text-icon-subtle shrink-0" />
                  <span class="text-12-regular text-text-strong truncate">{n.name}</span>
                  <span class="text-10-regular text-text-subtle ml-auto shrink-0">{props.fmtSize(n.size)}</span>
                </button>
              }
            >
              <button
                onClick={() => props.toggle(n.path)}
                class="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-raised-base-hover text-left"
                style={{ "padding-left": `${props.depth * 12 + 8}px` }}
              >
                <Icon name="folder-add-left" class="text-icon-secondary shrink-0" />
                <span class="text-12-semibold text-text-strong truncate">{n.name}</span>
                <span class="text-10-regular text-text-subtle ml-auto shrink-0">
                  {n.children?.length ?? 0} {props.open.has(n.path) ? "▾" : "▸"}
                </span>
              </button>
              <Show when={props.open.has(n.path) && n.children}>
                <Tree
                  nodes={n.children!}
                  depth={props.depth + 1}
                  open={props.open}
                  toggle={props.toggle}
                  onFile={props.onFile}
                  fmtSize={props.fmtSize}
                />
              </Show>
            </Show>
          </li>
        )}
      </For>
    </ul>
  )
}

export default function Security() {
  const navigate = useNavigate()
  const gsdk = useGlobalSDK()
  const platform = usePlatform()
  const rawFetcher = platform.fetch ?? fetch

  /**
   * Fetcher that auto-injects HTTP Basic Auth when the connected server has
   * credentials attached. Required because /security/* endpoints don't flow
   * through the SDK client and the raw `fetch` would drop the auth header.
   */
  const server = useServer()
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const current = server.current
    const http = current && current.type === "http" ? current.http : null
    if (!http?.password) return rawFetcher(input, init)
    const headers = new Headers(init?.headers ?? {})
    if (!headers.has("Authorization")) {
      if (http.username === "bearer") {
        headers.set("Authorization", `Bearer ${http.password}`)
      } else {
        headers.set("Authorization", "Basic " + btoa(`${http.username ?? "opencode"}:${http.password}`))
      }
    }
    return rawFetcher(input, { ...init, headers })
  }) as typeof fetch

  const [cat, setCat] = createSignal<Category>("all")
  const [copied, setCopied] = createSignal<string | null>(null)
  const [open, setOpen] = createSignal<Set<string>>(new Set())
  const [preview, setPreview] = createSignal<{ path: string; content: string } | null>(null)
  const [previewLoading, setPreviewLoading] = createSignal(false)

  const [engagements, { refetch }] = createResource<Engagement[]>(async () => {
    const r = await fetcher(`${gsdk.url}/security/findings`)
    if (!r.ok) return []
    return r.json()
  })

  const [stats, { refetch: refetchStats }] = createResource<any[]>(async () => {
    const r = await fetcher(`${gsdk.url}/security/dashboard`)
    if (!r.ok) return []
    return r.json()
  })

  const [pocs] = createResource<any[]>(async () => {
    const r = await fetcher(`${gsdk.url}/security/poc-templates`)
    if (!r.ok) return []
    return r.json()
  })

  async function importFindings(engagement: string, format: "nuclei" | "nmap", source: string) {
    const r = await fetcher(`${gsdk.url}/security/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engagement, format, source }),
    })
    const j = await r.json().catch(() => ({}))
    await refetch()
    await refetchStats()
    return j
  }

  function toggle(p: string) {
    const s = new Set(open())
    if (s.has(p)) s.delete(p)
    else s.add(p)
    setOpen(s)
  }

  async function openFile(p: string) {
    setPreviewLoading(true)
    setPreview({ path: p, content: "" })
    const r = await fetcher(`${gsdk.url}/security/findings/file?path=${encodeURIComponent(p)}`)
    const j = await r.json().catch(() => ({ content: "[lettura fallita]" }))
    setPreview({ path: p, content: j.content ?? j.error ?? "" })
    setPreviewLoading(false)
  }

  function fmtSize(n?: number) {
    if (n === undefined) return ""
    if (n < 1024) return `${n}B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
    return `${(n / 1024 / 1024).toFixed(1)}M`
  }

  const cats: { id: Category; label: string }[] = [
    { id: "all", label: "Tutti" },
    { id: "recon", label: "Ricognizione" },
    { id: "scanning", label: "Scansione" },
    { id: "exploitation", label: "Sfruttamento" },
    { id: "phishing", label: "Phishing" },
    { id: "reporting", label: "Report" },
    { id: "reversing", label: "Reverse Eng." },
    { id: "osint", label: "OSINT" },
    { id: "netrecon", label: "Network Recon" },
    { id: "vulnresearch", label: "Vuln Research" },
    { id: "se", label: "Social Eng." },
  ]

  const filtered = () => (cat() === "all" ? TOOLS : TOOLS.filter((t) => t.cat === cat()))

  function copy(text: string, id: string) {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div class="size-full overflow-y-auto bg-background-base">
      <div class="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center gap-3">
            <IconButton icon="arrow-left" variant="ghost" onClick={() => navigate("/")} aria-label="Indietro" />
            <div>
              <h1 class="text-18-semibold text-text-strong">Toolkit Sicurezza e Pentest</h1>
              <p class="text-12-regular text-text-weak">
                Workflow di sicurezza offensiva · Agente Pentester · {TOOLS.length} strumenti · 8 template phishing · 6
                template SE
              </p>
            </div>
          </div>
          <Button onClick={() => navigate("/")}>Apri Progetto</Button>
        </div>
        {/* Disclaimer */}
        <div class="mb-6 p-3 rounded border border-surface-warning bg-surface-warning/20">
          <div class="flex items-start gap-2">
            <Icon name="circle-ban-sign" class="text-icon-warning-base shrink-0 mt-0.5" />
            <div class="text-12-regular text-text-strong">
              <strong>Solo uso autorizzato.</strong> Questi strumenti non hanno protezioni integrate. Sei l'unico
              responsabile di assicurarti di avere un'autorizzazione scritta esplicita prima di colpire qualsiasi
              sistema. I test non autorizzati sono illegali.
            </div>
          </div>
        </div>
        {/* Quick Engagements */}
        <section class="mb-8">
          <h2 class="text-14-semibold text-text-strong mb-3">Engagement Rapidi</h2>
          <p class="text-12-regular text-text-weak mb-3">
            Copia un prompt predefinito, apri un progetto, passa all'agente{" "}
            <code class="bg-surface-weak px-1 rounded">pentester</code>, incolla &amp; esegui.
          </p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
            <For each={QUICK_ENGAGEMENTS}>
              {(eng) => (
                <button
                  onClick={() => copy(eng.prompt, eng.name)}
                  class="text-left p-3 rounded border border-surface-weak bg-surface-base hover:bg-surface-raised-base-hover transition-colors"
                >
                  <div class="flex items-center justify-between mb-1">
                    <div class="text-13-semibold text-text-strong">{eng.name}</div>
                    <span class="text-11-regular text-text-weak">
                      {copied() === eng.name ? "Copiato" : "Copia prompt"}
                    </span>
                  </div>
                  <div class="text-11-regular text-text-weak line-clamp-2">{eng.prompt}</div>
                </button>
              )}
            </For>
          </div>
        </section>
        {/* Tool Categories */}
        <section class="mb-8">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-14-semibold text-text-strong">Catalogo Strumenti</h2>
            <span class="text-11-regular text-text-weak">{filtered().length} strumenti</span>
          </div>
          <div class="flex gap-2 mb-3 overflow-x-auto">
            <For each={cats}>
              {(c) => (
                <button
                  onClick={() => setCat(c.id)}
                  class="px-3 py-1.5 rounded text-12-regular whitespace-nowrap transition-colors"
                  classList={{
                    "bg-icon-warning-base text-text-contrast": cat() === c.id,
                    "bg-surface-weak text-text-secondary hover:bg-surface-raised-base-hover": cat() !== c.id,
                  }}
                >
                  {c.label}
                </button>
              )}
            </For>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
            <For each={filtered()}>
              {(tool) => (
                <Tooltip value={tool.prompt} placement="top">
                  <button
                    onClick={() => copy(tool.prompt, tool.id)}
                    class="w-full text-left p-3 rounded border border-surface-weak bg-surface-base hover:bg-surface-raised-base-hover transition-colors"
                  >
                    <div class="flex items-center justify-between mb-1">
                      <div class="text-13-semibold text-text-strong">{tool.name}</div>
                      <span class="text-11-regular text-text-weak">{copied() === tool.id ? "Copiato" : tool.cat}</span>
                    </div>
                    <div class="text-11-regular text-text-weak">{tool.desc}</div>
                  </button>
                </Tooltip>
              )}
            </For>
          </div>
        </section>
        {/* Phishing Templates */}
        <section class="mb-8">
          <h2 class="text-14-semibold text-text-strong mb-3">Galleria Template Phishing</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
            <For each={PHISHING_TEMPLATES}>
              {(tpl) => {
                const prompt = `Usa lo strumento phishing con template=${tpl.id} brand=Acme target=user@example.com`
                return (
                  <button
                    onClick={() => copy(prompt, `phish-${tpl.id}`)}
                    class="text-left p-3 rounded border border-surface-weak bg-surface-base hover:bg-surface-raised-base-hover transition-colors"
                  >
                    <div class="text-12-semibold text-text-strong mb-1">{tpl.name}</div>
                    <div class="text-11-regular text-text-weak mb-2">{tpl.desc}</div>
                    <div class="text-10-regular text-text-subtle">
                      {copied() === `phish-${tpl.id}` ? "Prompt copiato" : "Clicca per copiare il prompt"}
                    </div>
                  </button>
                )
              }}
            </For>
          </div>
        </section>
        {/* SE Templates */}
        <section class="mb-8">
          <h2 class="text-14-semibold text-text-strong mb-3">Galleria Template Social Engineering</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            <For each={SE_TEMPLATES}>
              {(tpl) => {
                const prompt = `Genera uno scenario di social engineering tipo '${tpl.id}' per engagement contro <azienda> usando questi dettagli OSINT: <dettagli>`
                return (
                  <button
                    onClick={() => copy(prompt, `se-${tpl.id}`)}
                    class="text-left p-3 rounded border border-surface-weak bg-surface-base hover:bg-surface-raised-base-hover transition-colors"
                  >
                    <div class="text-12-semibold text-text-strong mb-1">{tpl.name}</div>
                    <div class="text-11-regular text-text-weak mb-2">{tpl.desc}</div>
                    <div class="text-10-regular text-text-subtle">
                      {copied() === `se-${tpl.id}` ? "Prompt copiato" : "Clicca per copiare il prompt"}
                    </div>
                  </button>
                )
              }}
            </For>
          </div>
        </section>
        {/* CLI Reference */}{" "}
        <section class="mb-8">
          <h2 class="text-14-semibold text-text-strong mb-3">Riferimento Rapido CLI</h2>
          <p class="text-12-regular text-text-weak mb-3">
            Clicca qualsiasi riga per copiare. Esegui da qualsiasi root di progetto; l'output finisce in{" "}
            <code class="bg-surface-weak px-1 rounded">pentest-output/</code>.
          </p>
          <div class="rounded border border-surface-weak bg-surface-base overflow-hidden">
            <For
              each={[
                { cmd: "opencode sec recon <dominio>", desc: "WHOIS + DNS + SSL + header di sicurezza" },
                { cmd: "opencode sec scan <bersaglio>", desc: "Scansione attiva delle porte (porte comuni)" },
                { cmd: "opencode sec vuln <url>", desc: "Vulnerabilità web: XSS, SQLi, CSRF, IDOR, SSRF" },
                { cmd: "opencode sec playbook <bersaglio>", desc: "Catena recon → scan → vuln → report" },
                { cmd: "opencode sec phish <template> --brand Acme", desc: "Genera kit phishing (8 template)" },
                { cmd: "opencode sec report <findings.json>", desc: "Compila report markdown con punteggio CVSS" },
                { cmd: "opencode sec jwt <azione> <token>", desc: "decode | tamper_none | tamper_hs256 | brute_hs256" },
                { cmd: "opencode sec ssrf <url-con-FUZZ>", desc: "Sonda SSRF (metadati cloud, host interni)" },
                { cmd: "opencode sec cve <query>", desc: "Ricerca PoC CVE (es. CVE-2021-44228, log4j)" },
                { cmd: "opencode sec nmap <bersaglio> --flags '-sV -sC'", desc: "Wrapper nmap (richiede nmap locale)" },
                {
                  cmd: "opencode sec nuclei <bersaglio> --severity high,critical",
                  desc: "Wrapper nuclei (richiede nuclei locale)",
                },
                {
                  cmd: "opencode sec sqlmap <url> --data 'id=1' --level 3",
                  desc: "Wrapper sqlmap (richiede sqlmap locale)",
                },
                { cmd: "opencode sec re <binario>", desc: "Reverse engineering: strings, entropy, disasm, YARA" },
                { cmd: "opencode sec osint <dominio>", desc: "OSINT: crt.sh, Shodan dork, Google dork, email enum" },
                { cmd: "opencode sec netrecon <CIDR>", desc: "Network recon passivo: ASN, banner grab, traceroute" },
                {
                  cmd: "opencode sec vulnresearch <cve-o-tech>",
                  desc: "CVE search, patch diff, dep audit, exploit search",
                },
                { cmd: "opencode sec se <azienda>", desc: "Social engineering: pretexting, vishing, spear-phish" },
              ]}
            >
              {(row) => (
                <button
                  onClick={() => copy(row.cmd, row.cmd)}
                  class="w-full flex items-center justify-between gap-3 px-3 py-2 border-b border-surface-weak last:border-b-0 hover:bg-surface-raised-base-hover transition-colors text-left"
                >
                  <code class="text-12-mono text-text-strong">{row.cmd}</code>
                  <span class="text-11-regular text-text-weak shrink-0">
                    {copied() === row.cmd ? "Copiato" : row.desc}
                  </span>
                </button>
              )}
            </For>
          </div>
        </section>
        {/* Findings & Output */}
        <section class="mb-8">
          <h2 class="text-14-semibold text-text-strong mb-3">Risultati e Output</h2>
          <div class="rounded border border-surface-weak bg-surface-base p-4 space-y-3">
            <div class="flex items-start gap-3">
              <Icon name="folder-add-left" class="text-icon-secondary shrink-0 mt-0.5" />
              <div class="flex-1">
                <div class="text-13-semibold text-text-strong">Directory di output dell'engagement</div>
                <code class="text-11-mono text-text-weak block mt-1">
                  &lt;progetto&gt;/pentest-output/&lt;nome-engagement&gt;/
                </code>
                <p class="text-11-regular text-text-weak mt-1">
                  Tutti gli strumenti sec e i comandi CLI scrivono qui risultati, scansioni e kit di phishing. Apri
                  l'albero dei file in un progetto per esplorare, oppure usa{" "}
                  <code class="bg-surface-weak px-1 rounded">opencode sec report</code> per compilarli.
                </p>
              </div>
            </div>
            <div class="flex items-start gap-3">
              <Icon name="code-lines" class="text-icon-secondary shrink-0 mt-0.5" />
              <div class="flex-1">
                <div class="text-13-semibold text-text-strong">Artefatti tipici</div>
                <ul class="text-11-regular text-text-weak mt-1 space-y-0.5">
                  <li>
                    <code class="bg-surface-weak px-1 rounded">recon.json</code> — WHOIS, DNS, SSL, header
                  </li>
                  <li>
                    <code class="bg-surface-weak px-1 rounded">scan.json</code> — scansione porte + output nmap
                  </li>
                  <li>
                    <code class="bg-surface-weak px-1 rounded">vulns.json</code> — risultati vuln_scanner / nuclei
                  </li>
                  <li>
                    <code class="bg-surface-weak px-1 rounded">phishing-&lt;brand&gt;/</code> — email, landing, SMS,
                    script vishing
                  </li>
                  <li>
                    <code class="bg-surface-weak px-1 rounded">report.md</code> — report finale con punteggio CVSS
                  </li>
                </ul>
              </div>
            </div>
            <div class="flex items-start gap-3">
              <Icon name="circle-ban-sign" class="text-icon-warning-base shrink-0 mt-0.5" />
              <div class="flex-1">
                <div class="text-13-semibold text-text-strong">Passa all'agente pentester</div>
                <p class="text-11-regular text-text-weak mt-1">
                  Apri un progetto, poi nel composer premi <kbd class="bg-surface-weak px-1 rounded">@</kbd> e seleziona{" "}
                  <code class="bg-surface-weak px-1 rounded">pentester</code>. L'agente ha tutto il toolset sec
                  abilitato e segue la metodologia PTES / OWASP WSTG.
                </p>
              </div>
            </div>
          </div>
        </section>
        {/* Findings Browser */}
        <section class="mb-8">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-14-semibold text-text-strong">Esploratore Risultati</h2>
            <button
              onClick={() => {
                void refetch()
                void refetchStats()
              }}
              class="text-11-regular text-text-weak hover:text-text-strong px-2 py-1 rounded hover:bg-surface-raised-base-hover"
            >
              {engagements.loading ? "Caricamento…" : "Aggiorna"}
            </button>
          </div>

          {/* Engagement Dashboard */}
          <Show when={(stats()?.length ?? 0) > 0}>
            <div class="mb-4 rounded border border-surface-weak bg-surface-base p-3">
              <div class="text-12-semibold text-text-strong mb-2">Dashboard Engagement</div>
              <div class="flex flex-col gap-1">
                <For each={stats()}>
                  {(s) => (
                    <div class="flex items-center justify-between gap-2 text-11-regular">
                      <span class="font-mono text-text-weak truncate">
                        {s.project} / {s.engagement}
                      </span>
                      <div class="flex items-center gap-1">
                        <span class="text-text-weak">{s.total} totali</span>
                        <Show when={s.counts.critical > 0}>
                          <span class="px-1.5 rounded bg-fill-critical text-text-on-accent">
                            {s.counts.critical} critici
                          </span>
                        </Show>
                        <Show when={s.counts.high > 0}>
                          <span class="px-1.5 rounded bg-fill-warning text-text-on-accent">{s.counts.high} alti</span>
                        </Show>
                        <Show when={s.counts.medium > 0}>
                          <span class="px-1.5 rounded bg-fill-accent text-text-on-accent">{s.counts.medium} medi</span>
                        </Show>
                        <Show when={s.counts.low > 0}>
                          <span class="px-1.5 rounded bg-fill-subtle text-text-weak">{s.counts.low} bassi</span>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
              <div class="mt-2 flex gap-2">
                <button
                  class="text-11-regular px-2 py-1 rounded bg-fill-accent text-text-on-accent"
                  onClick={async () => {
                    const eng = prompt("Nome engagement:")
                    if (!eng) return
                    const src = prompt("Percorso file nuclei.jsonl o testo:")
                    if (!src) return
                    const r = await importFindings(eng, "nuclei", src)
                    alert(`Importati ${r.added ?? 0} risultati`)
                  }}
                >
                  Importa Nuclei
                </button>
                <button
                  class="text-11-regular px-2 py-1 rounded bg-fill-accent text-text-on-accent"
                  onClick={async () => {
                    const eng = prompt("Nome engagement:")
                    if (!eng) return
                    const src = prompt("Percorso file nmap.xml o XML:")
                    if (!src) return
                    const r = await importFindings(eng, "nmap", src)
                    alert(`Importati ${r.added ?? 0} risultati`)
                  }}
                >
                  Importa Nmap
                </button>
              </div>
            </div>
          </Show>

          {/* PoC Templates */}
          <Show when={(pocs()?.length ?? 0) > 0}>
            <details class="mb-4 rounded border border-surface-weak bg-surface-base p-3">
              <summary class="text-12-semibold text-text-strong cursor-pointer">
                Modelli PoC ({pocs()?.length ?? 0})
              </summary>
              <div class="mt-2 flex flex-col gap-2">
                <For each={pocs()}>
                  {(p) => (
                    <div class="rounded border border-surface-weak p-2">
                      <div class="flex items-center gap-2 mb-1">
                        <span class="text-11-semibold text-text-strong">{p.title}</span>
                        <span class="text-10-regular px-1 rounded bg-fill-subtle text-text-weak">{p.severity}</span>
                        <span class="text-10-regular text-text-weak font-mono">{p.cwe}</span>
                      </div>
                      <pre class="text-10-regular bg-surface-base-pressed text-text-strong rounded p-2 overflow-x-auto whitespace-pre-wrap">
                        {p.payload}
                      </pre>
                      <div class="text-10-regular text-text-weak mt-1">{p.notes}</div>
                    </div>
                  )}
                </For>
              </div>
            </details>
          </Show>
          <Show
            when={!engagements.loading && (engagements()?.length ?? 0) > 0}
            fallback={
              <div class="rounded border border-surface-weak bg-surface-base p-4 text-12-regular text-text-weak">
                <Show when={engagements.loading} fallback="Nessuna cartella pentest-output/ trovata nei progetti.">
                  Scansione progetti…
                </Show>
              </div>
            }
          >
            <div class="rounded border border-surface-weak bg-surface-base divide-y divide-surface-weak">
              <For each={engagements()}>
                {(eng) => (
                  <div class="p-3">
                    <div class="flex items-center gap-2 mb-2">
                      <Icon name="folder-add-left" class="text-icon-secondary" />
                      <div class="text-13-semibold text-text-strong">{eng.project}</div>
                      <code class="text-10-mono text-text-subtle truncate">{eng.root}</code>
                    </div>
                    <Tree
                      nodes={eng.tree}
                      depth={0}
                      open={open()}
                      toggle={toggle}
                      onFile={openFile}
                      fmtSize={fmtSize}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
        {/* File Preview Modal */}
        <Show when={preview()}>
          {(p) => (
            <div
              class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
              onClick={() => setPreview(null)}
            >
              <div
                class="bg-background-base border border-surface-weak rounded shadow-lg w-full max-w-4xl max-h-[80vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                <div class="flex items-center justify-between px-4 py-2 border-b border-surface-weak">
                  <code class="text-11-mono text-text-weak truncate">{p().path}</code>
                  <IconButton
                    icon="circle-ban-sign"
                    variant="ghost"
                    onClick={() => setPreview(null)}
                    aria-label="Chiudi"
                  />
                </div>
                <div class="flex-1 overflow-auto p-4">
                  <Show
                    when={!previewLoading()}
                    fallback={<div class="text-12-regular text-text-weak">Caricamento…</div>}
                  >
                    <pre class="text-11-mono text-text-strong whitespace-pre-wrap break-words">{p().content}</pre>
                  </Show>
                </div>
              </div>
            </div>
          )}
        </Show>
        {/* Footer */}
        <div class="text-11-regular text-text-subtle text-center py-4">
          Metodologia: PTES · OWASP WSTG · MITRE ATT&amp;CK · Vedi la skill pentester in{" "}
          <code>~/.agents/skills/pentester</code>
        </div>
        <Show when={false}>
          {/* keep imports referenced */}
          <div />
        </Show>
      </div>
    </div>
  )
}
