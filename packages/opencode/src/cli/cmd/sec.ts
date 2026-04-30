import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { DNSTool } from "../../tool/dns_lookup"
import { WHOISTool } from "../../tool/whois"
import { SSLCheckerTool } from "../../tool/ssl_checker"
import { SecurityHeadersTool } from "../../tool/security_headers"
import { URLAnalyzerTool } from "../../tool/url_analyzer"
import { PortScannerTool } from "../../tool/port_scanner"
import { VulnScannerTool } from "../../tool/vuln_scanner"
import { PhishingTool } from "../../tool/phishing"
import { PentestReportTool } from "../../tool/pentest_report"
import { JWTTool } from "../../tool/jwt_tool"
import { SSRFProbeTool } from "../../tool/ssrf_probe"
import { CVEPocTool } from "../../tool/cve_poc"
import { NmapTool, NucleiTool, SqlmapTool } from "../../tool/external_scanners"
import { Tool } from "../../tool/tool"
import { ReverseShellTool } from "../../tool/reverse_shell"
import { PayloadGeneratorTool } from "../../tool/payload_generator"
import { PrivEscSuggesterTool } from "../../tool/privesc_suggester"
import { CredentialDumperTool } from "../../tool/credential_dumper"
import { C2GeneratorTool } from "../../tool/c2_generator"
import { SSTITool } from "../../tool/ssti_tool"
import { AMSIBypassTool } from "../../tool/amsi_bypass"
import { PersistenceTool } from "../../tool/persistence_tool"
import fs from "fs/promises"
import path from "path"

async function run(tool: Tool.Info, args: Record<string, unknown>) {
  const init = await tool.init({})
  const result = await init.execute(args, {
    sessionID: "cli",
    messageID: "cli",
    callID: "cli",
    abort: new AbortController().signal,
    metadata: () => {},
    extra: {},
  } as any)
  const out = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)
  UI.println(out)
  return { out, meta: result.metadata as any }
}

const Recon = cmd({
  command: "recon <target>",
  describe: "passive reconnaissance: WHOIS, DNS, SSL, security headers",
  builder: (y: Argv) => y.positional("target", { type: "string", demandOption: true }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const target = args.target as string
      const host = target.replace(/^https?:\/\//, "").split("/")[0]
      UI.println(UI.Style.TEXT_HIGHLIGHT + `[recon] ${target}` + UI.Style.TEXT_NORMAL)
      UI.println("\n--- WHOIS ---")
      await run(WHOISTool, { domain: host })
      UI.println("\n--- DNS ---")
      await run(DNSTool, { action: "lookup", domain: host })
      UI.println("\n--- SSL ---")
      await run(SSLCheckerTool, { host })
      UI.println("\n--- Security Headers ---")
      await run(SecurityHeadersTool, { url: target.startsWith("http") ? target : `https://${host}` })
      UI.println("\n--- URL Analysis ---")
      await run(URLAnalyzerTool, { url: target.startsWith("http") ? target : `https://${host}` })
    })
  },
})

const Scan = cmd({
  command: "scan <target>",
  describe: "active port scan",
  builder: (y: Argv) =>
    y
      .positional("target", { type: "string", demandOption: true })
      .option("ports", { type: "string", default: "common", describe: "ports (e.g. 1-1000, 22,80,443, common)" })
      .option("timeout", { type: "number", default: 1000 }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(PortScannerTool, { target: args.target, ports: args.ports, timeout: args.timeout })
    })
  },
})

const Vuln = cmd({
  command: "vuln <url>",
  describe: "web vulnerability scan (XSS, SQLi, CSRF, IDOR, SSRF)",
  builder: (y: Argv) =>
    y
      .positional("url", { type: "string", demandOption: true })
      .option("checks", { type: "array", default: ["all"], describe: "xss sqli csrf idor ssrf all" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(VulnScannerTool, { url: args.url, checks: args.checks })
    })
  },
})

const Phish = cmd({
  command: "phish <template>",
  describe: "generate phishing simulation template",
  builder: (y: Argv) =>
    y
      .positional("template", {
        type: "string",
        choices: [
          "credential_harvest",
          "fake_login",
          "attachment_lure",
          "password_reset",
          "mfa_bypass",
          "vishing_script",
          "sms_lure",
          "usb_drop",
        ],
        demandOption: true,
      })
      .option("brand", { type: "string", demandOption: true })
      .option("out", { type: "string", default: "./phishing-output" })
      .option("tracker", { type: "string" })
      .option("sender", { type: "string" })
      .option("subject", { type: "string" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(PhishingTool, {
        template: args.template,
        brand: args.brand,
        out: args.out,
        tracker: args.tracker,
        sender: args.sender,
        subject: args.subject,
      })
    })
  },
})

const Report = cmd({
  command: "report <findings>",
  describe: "generate pentest report from findings JSON file",
  builder: (y: Argv) =>
    y
      .positional("findings", { type: "string", describe: "path to findings.json", demandOption: true })
      .option("target", { type: "string", demandOption: true })
      .option("out", { type: "string" })
      .option("format", { type: "string", choices: ["markdown", "html"], default: "markdown" })
      .option("client", { type: "string" })
      .option("tester", { type: "string" })
      .option("scope", { type: "string" })
      .option("methodology", { type: "string" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const data = JSON.parse(await fs.readFile(args.findings as string, "utf-8"))
      await run(PentestReportTool, {
        target: args.target,
        findings: Array.isArray(data) ? data : data.findings,
        format: args.format,
        out: args.out,
        client: args.client,
        tester: args.tester,
        scope: args.scope,
        methodology: args.methodology,
      })
    })
  },
})

const Playbook = cmd({
  command: "playbook <target>",
  describe: "chained workflow: recon -> scan -> vuln -> draft report",
  builder: (y: Argv) =>
    y
      .positional("target", { type: "string", demandOption: true })
      .option("ports", { type: "string", default: "common" })
      .option("out", { type: "string", default: "./pentest-output" })
      .option("client", { type: "string", default: "Unknown" })
      .option("tester", { type: "string", default: "OpenCode Pentester" })
      .option("format", { type: "string", choices: ["markdown", "html"], default: "markdown" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const target = args.target as string
      const host = target.replace(/^https?:\/\//, "").split("/")[0]
      const url = target.startsWith("http") ? target : `https://${host}`
      const out = args.out as string
      await fs.mkdir(out, { recursive: true })
      const log: string[] = []
      const stamp = (label: string, body: string) => {
        log.push(`\n## ${label}\n\n\`\`\`\n${body}\n\`\`\`\n`)
      }
      UI.println(UI.Style.TEXT_HIGHLIGHT + `[playbook] ${target}` + UI.Style.TEXT_NORMAL)
      UI.println("\n--- phase 1: recon ---")
      stamp("WHOIS", (await run(WHOISTool, { domain: host })).out)
      stamp("DNS", (await run(DNSTool, { action: "lookup", domain: host })).out)
      stamp("SSL", (await run(SSLCheckerTool, { host })).out)
      stamp("Security Headers", (await run(SecurityHeadersTool, { url })).out)
      stamp("URL Analysis", (await run(URLAnalyzerTool, { url })).out)
      UI.println("\n--- phase 2: port scan ---")
      stamp("Port Scan", (await run(PortScannerTool, { target: host, ports: args.ports, timeout: 1000 })).out)
      UI.println("\n--- phase 3: vuln scan ---")
      const vuln = await run(VulnScannerTool, { url, checks: ["all"] })
      stamp("Vulnerability Scan", vuln.out)
      const raw = (vuln.meta?.findings ?? []) as Array<any>
      const normalized = raw.length
        ? raw.map((f) => ({
            title: f.title ?? "Unnamed finding",
            severity: (f.severity ?? "info").toLowerCase(),
            description: f.description ?? "",
            evidence: f.evidence ?? "",
            recommendation: f.recommendation ?? "",
          }))
        : [
            {
              title: "No automated findings detected",
              severity: "info",
              description: "Automated checks did not surface vulnerabilities. Manual testing recommended.",
              evidence: "",
              recommendation: "Perform authenticated/manual review of business logic, auth, data handling.",
            },
          ]
      await fs.writeFile(path.join(out, "findings.json"), JSON.stringify(normalized, null, 2))
      await fs.writeFile(path.join(out, "evidence.md"), `# Evidence Log: ${target}\n` + log.join("\n"))
      UI.println("\n--- phase 4: report ---")
      await run(PentestReportTool, {
        target,
        findings: normalized,
        format: args.format,
        out: path.join(out, `report.${args.format === "html" ? "html" : "md"}`),
        client: args.client,
        tester: args.tester,
        scope: target,
        methodology: "PTES + OWASP WSTG (automated playbook)",
      })
      UI.println(UI.Style.TEXT_SUCCESS + `\n[done] artifacts in ${out}` + UI.Style.TEXT_NORMAL)
    })
  },
})

const Jwt = cmd({
  command: "jwt <action> <token>",
  describe: "JWT decode/tamper/brute (decode, tamper_none, tamper_hs256, brute_hs256)",
  builder: (y: Argv) =>
    y
      .positional("action", {
        type: "string",
        choices: ["decode", "tamper_none", "tamper_hs256", "brute_hs256"],
        demandOption: true,
      })
      .positional("token", { type: "string", demandOption: true })
      .option("payload", { type: "string", describe: "JSON payload override" })
      .option("secret", { type: "string", describe: "HMAC secret for tamper_hs256" })
      .option("wordlist", { type: "string", describe: "Path to newline-separated secret wordlist for brute_hs256" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const list = args.wordlist
        ? (await fs.readFile(args.wordlist as string, "utf-8")).split(/\r?\n/).filter(Boolean)
        : undefined
      await run(JWTTool, {
        action: args.action,
        token: args.token,
        payload: args.payload,
        secret: args.secret,
        wordlist: list,
      })
    })
  },
})

const Ssrf = cmd({
  command: "ssrf <url>",
  describe: "SSRF probe with FUZZ marker (e.g., 'https://app/api?u=FUZZ')",
  builder: (y: Argv) =>
    y
      .positional("url", { type: "string", demandOption: true })
      .option("method", { type: "string", choices: ["GET", "POST"], default: "GET" })
      .option("collaborator", { type: "string", describe: "Out-of-band callback domain" })
      .option("payloads", { type: "string", describe: "Path to newline-separated payloads file" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const list = args.payloads
        ? (await fs.readFile(args.payloads as string, "utf-8")).split(/\r?\n/).filter(Boolean)
        : undefined
      await run(SSRFProbeTool, {
        url: args.url,
        method: args.method,
        collaborator: args.collaborator,
        payloads: list,
      })
    })
  },
})

const Cve = cmd({
  command: "cve <query>",
  describe: "CVE PoC lookup (e.g., 'CVE-2021-44228' or 'log4j')",
  builder: (y: Argv) =>
    y
      .positional("query", { type: "string", demandOption: true })
      .option("target", { type: "string", describe: "Target URL/host to substitute into payload" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(CVEPocTool, { query: args.query, target: args.target })
    })
  },
})

const Nmap = cmd({
  command: "nmap <target>",
  describe: "nmap wrapper (requires local nmap binary)",
  builder: (y: Argv) =>
    y
      .positional("target", { type: "string", demandOption: true })
      .option("flags", { type: "string", describe: "Override flags (default: '-sV -T4 -Pn --top-ports 1000')" })
      .option("timeout", { type: "number", default: 300000 }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(NmapTool, { target: args.target, flags: args.flags, timeout: args.timeout })
    })
  },
})

const Nuclei = cmd({
  command: "nuclei <target>",
  describe: "nuclei wrapper (requires local nuclei binary)",
  builder: (y: Argv) =>
    y
      .positional("target", { type: "string", demandOption: true })
      .option("templates", { type: "string", describe: "Template tags (default: cves,vulnerabilities)" })
      .option("severity", { type: "string", describe: "Comma severities: critical,high,medium,low,info" })
      .option("timeout", { type: "number", default: 600000 }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(NucleiTool, {
        target: args.target,
        templates: args.templates,
        severity: args.severity,
        timeout: args.timeout,
      })
    })
  },
})

const Sqlmap = cmd({
  command: "sqlmap <url>",
  describe: "sqlmap wrapper (requires local sqlmap binary)",
  builder: (y: Argv) =>
    y
      .positional("url", { type: "string", demandOption: true })
      .option("data", { type: "string", describe: "POST data (e.g., 'user=*&pass=*')" })
      .option("level", { type: "number", describe: "Test level 1-5" })
      .option("risk", { type: "number", describe: "Risk 1-3" })
      .option("flags", { type: "string", describe: "Extra flags (e.g., '--batch --dbs')" })
      .option("timeout", { type: "number", default: 600000 }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(SqlmapTool, {
        url: args.url,
        data: args.data,
        level: args.level,
        risk: args.risk,
        flags: args.flags,
        timeout: args.timeout,
      })
    })
  },
})

const ReverseShell = cmd({
  command: "shell",
  describe: "reverse shell handler (generate, listen, sessions, upgrade)",
  builder: (y: Argv) =>
    y
      .option("action", {
        type: "string",
        choices: ["generate", "listen", "sessions", "send", "kill", "upgrade"],
        demandOption: true,
      })
      .option("lhost", { type: "string", describe: "Listener IP" })
      .option("lport", { type: "number", describe: "Listener port" })
      .option("platform", { type: "string", choices: ["linux", "windows", "macos", "all"] })
      .option("session", { type: "string", describe: "Session ID" })
      .option("command", { type: "string", describe: "Command to send" })
      .option("encoding", { type: "string", choices: ["none", "base64", "hex", "url"] })
      .option("format", { type: "string" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(ReverseShellTool, {
        action: args.action,
        lhost: args.lhost,
        lport: args.lport,
        platform: args.platform,
        session: args.session,
        command: args.command,
        encoding: args.encoding,
        format: args.format,
      })
    })
  },
})

const PayloadGen = cmd({
  command: "payload",
  describe: "generate polyglot reverse shell payloads",
  builder: (y: Argv) =>
    y
      .option("lhost", { type: "string", demandOption: true })
      .option("lport", { type: "number", default: 4444 })
      .option("format", { type: "string", default: "all" })
      .option("encoding", { type: "string", default: "none" })
      .option("method", { type: "string", default: "shell" })
      .option("sleep", { type: "number", default: 5 })
      .option("retry", { type: "boolean", default: false })
      .option("os", { type: "string", default: "all" })
      .option("useragent", { type: "string" })
      .option("inline", { type: "boolean", default: true }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(PayloadGeneratorTool, {
        lhost: args.lhost,
        lport: args.lport,
        format: args.format,
        encoding: args.encoding,
        method: args.method,
        sleep: args.sleep,
        retry: args.retry,
        os: args.os,
        useragent: args.useragent,
        inline: args.inline,
      })
    })
  },
})

const Privesc = cmd({
  command: "privesc",
  describe: "local privilege escalation suggester",
  builder: (y: Argv) =>
    y
      .option("platform", { type: "string", choices: ["linux", "windows", "macos", "auto"] })
      .option("thorough", { type: "boolean", default: false })
      .option("commands", { type: "string", describe: "Paste command output to analyze" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(PrivEscSuggesterTool, {
        platform: args.platform,
        thorough: args.thorough,
        commands: args.commands,
      })
    })
  },
})

const Creds = cmd({
  command: "creds",
  describe: "credential dumper (cross-platform)",
  builder: (y: Argv) =>
    y
      .option("platform", { type: "string", choices: ["linux", "windows", "auto", "all"] })
      .option("target", { type: "string", default: "all" })
      .option("output_format", { type: "string", choices: ["commands", "script", "both"], default: "commands" })
      .option("lhost", { type: "string" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(CredentialDumperTool, {
        platform: args.platform,
        target: args.target,
        output_format: args.output_format,
        lhost: args.lhost,
      })
    })
  },
})

const C2Gen = cmd({
  command: "c2",
  describe: "C2 implant generator",
  builder: (y: Argv) =>
    y
      .option("channel", { type: "string", choices: ["http", "https", "dns", "websocket", "all"], default: "all" })
      .option("lhost", { type: "string", demandOption: true })
      .option("lport", { type: "number", default: 443 })
      .option("encryption", { type: "string", choices: ["xor", "aes256", "chacha20", "none"], default: "xor" })
      .option("sleep", { type: "number", default: 60 })
      .option("jitter", { type: "number", default: 20 })
      .option("format", {
        type: "string",
        choices: ["python", "powershell", "c", "rust", "go", "js", "vbs", "all"],
        default: "all",
      })
      .option("persist", { type: "boolean", default: false })
      .option("useragent", { type: "string" })
      .option("implant_name", { type: "string" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(C2GeneratorTool, {
        channel: args.channel,
        lhost: args.lhost,
        lport: args.lport,
        encryption: args.encryption,
        sleep: args.sleep,
        jitter: args.jitter,
        format: args.format,
        persist: args.persist,
        useragent: args.useragent,
        implant_name: args.implant_name,
      })
    })
  },
})

const SSTICmd = cmd({
  command: "ssti",
  describe: "SSTI exploitation toolkit",
  builder: (y: Argv) =>
    y
      .option("action", { type: "string", choices: ["detect", "exploit", "payloads", "rce"], demandOption: true })
      .option("url", { type: "string" })
      .option("template", { type: "string", default: "auto" })
      .option("command", { type: "string", default: "id" })
      .option("method", { type: "string", choices: ["GET", "POST"], default: "GET" })
      .option("param", { type: "string", default: "q" })
      .option("value", { type: "string" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(SSTITool, {
        action: args.action,
        url: args.url,
        template: args.template,
        command: args.command,
        method: args.method,
        param: args.param,
        value: args.value,
      })
    })
  },
})

const AMSICmd = cmd({
  command: "amsi",
  describe: "AMSI/EDR bypass engine",
  builder: (y: Argv) =>
    y
      .option("bypass", {
        type: "string",
        choices: ["amsi", "clm", "applocker", "etw", "all", "obfuscation"],
        demandOption: true,
      })
      .option("format", { type: "string", choices: ["inline", "script", "encoded", "all"], default: "all" })
      .option("command", { type: "string" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(AMSIBypassTool, {
        bypass: args.bypass,
        format: args.format,
        command: args.command,
      })
    })
  },
})

const PersistCmd = cmd({
  command: "persist",
  describe: "persistence deployment toolkit",
  builder: (y: Argv) =>
    y
      .option("platform", { type: "string", choices: ["windows", "linux", "macos", "all"], default: "all" })
      .option("method", { type: "string", default: "all" })
      .option("payload", { type: "string", demandOption: true })
      .option("name", { type: "string" })
      .option("schedule", { type: "string" })
      .option("user", { type: "string" })
      .option("elevated", { type: "boolean", default: false })
      .option("hide", { type: "boolean", default: true }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      await run(PersistenceTool, {
        platform: args.platform,
        method: args.method,
        payload: args.payload,
        name: args.name,
        schedule: args.schedule,
        user: args.user,
        elevated: args.elevated,
        hide: args.hide,
      })
    })
  },
})

export const SecCommand = cmd({
  command: "sec",
  describe:
    "offensive security toolkit (recon, scan, vuln, phish, report, playbook, shell, payload, privesc, creds, c2, ssti, amsi, persist)",
  builder: (y: Argv) =>
    y
      .command(Recon)
      .command(Scan)
      .command(Vuln)
      .command(Phish)
      .command(Report)
      .command(Playbook)
      .command(Jwt)
      .command(Ssrf)
      .command(Cve)
      .command(Nmap)
      .command(Nuclei)
      .command(Sqlmap)
      .command(ReverseShell)
      .command(PayloadGen)
      .command(Privesc)
      .command(Creds)
      .command(C2Gen)
      .command(SSTICmd)
      .command(AMSICmd)
      .command(PersistCmd)
      .demandCommand(),
  async handler() {},
})
